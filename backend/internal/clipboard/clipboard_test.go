package clipboard

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCommandTablesArePerPlatform(t *testing.T) {
	if got := readCommands("darwin"); len(got) != 1 || got[0][0] != "pbpaste" {
		t.Fatalf("darwin reader: %#v", got)
	}
	if got := readCommands("windows"); len(got) != 1 || got[0][0] != "powershell" {
		t.Fatalf("windows reader: %#v", got)
	}
	if got := readCommands("linux"); len(got) != 3 || got[0][0] != "wl-paste" || got[2][0] != "xsel" {
		t.Fatalf("linux readers: %#v", got)
	}
	if got := writeCommands("linux"); len(got) != 3 || got[0][0] != "wl-copy" || got[2][0] != "xsel" {
		t.Fatalf("linux writers: %#v", got)
	}
	if readCommands("plan9") != nil || writeCommands("plan9") != nil {
		t.Fatal("expected no commands for an unsupported platform")
	}
}

func TestUnsupportedPlatformFails(t *testing.T) {
	if _, err := read(context.Background(), "plan9"); err == nil {
		t.Fatal("expected read to fail")
	}
	if err := write(context.Background(), "plan9", "x"); err == nil {
		t.Fatal("expected write to fail")
	}
}

func TestReadFallsBackToInstalledTool(t *testing.T) {
	dir := stubBin(t)
	stub(t, dir, "xclip", `printf 'from-xclip'`)
	text, err := read(context.Background(), "linux")
	if err != nil {
		t.Fatal(err)
	}
	if text != "from-xclip" {
		t.Fatalf("got %q", text)
	}
}

func TestReadReportsMissingTools(t *testing.T) {
	stubBin(t)
	_, err := read(context.Background(), "linux")
	if err == nil || !strings.Contains(err.Error(), "读取剪贴板失败") {
		t.Fatalf("got %v", err)
	}
}

func TestReadRejectsOversizedClipboard(t *testing.T) {
	dir := stubBin(t)
	stub(t, dir, "pbpaste", `i=0
while [ $i -lt 1100 ]; do printf '%01024d' $i; i=$((i+1)); done`)
	if _, err := read(context.Background(), "darwin"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v", err)
	}
}

func TestWritePassesTextOnStdin(t *testing.T) {
	dir := stubBin(t)
	captured := filepath.Join(dir, "captured")
	stub(t, dir, "wl-copy", `/bin/cat > "$FAKE_CAPTURE"`)
	t.Setenv("FAKE_CAPTURE", captured)
	if err := write(context.Background(), "linux", "粘贴内容"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(captured)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "粘贴内容" {
		t.Fatalf("got %q", got)
	}
}

func TestWriteReportsMissingTools(t *testing.T) {
	stubBin(t)
	err := write(context.Background(), "darwin", "x")
	if err == nil || !strings.Contains(err.Error(), "写入剪贴板失败") {
		t.Fatalf("got %v", err)
	}
}

// stubBin points PATH at an empty directory, so a test that misses a stub
// fails like a missing tool instead of reaching the machine's real clipboard.
func stubBin(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("clipboard stubs are POSIX shell scripts")
	}
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	return dir
}

func stub(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
