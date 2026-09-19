// Package clipboard reads and writes the operating system clipboard.
//
// The plugin UI runs in a sandboxed iframe (sandbox="allow-scripts"), so its
// document has an opaque origin: the browser's permissions policy rejects
// every Clipboard API call there, and WebKit refuses scripted pasting outright.
// The sidecar is an ordinary process on the user's machine, outside that
// sandbox, so the platform's own clipboard tooling is the only text read path
// that works in the real host.
package clipboard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// MaxTextBytes caps one paste. Larger payloads are not text the user meant to
// drop into a request field, and the host bridge rejects oversized messages.
const MaxTextBytes = 1 << 20

// timeout bounds each helper process; a wedged clipboard owner (X11 selection,
// a hung PowerShell) must not hang the RPC.
const timeout = 5 * time.Second

// ErrTooLarge reports clipboard content beyond MaxTextBytes.
var ErrTooLarge = errors.New("剪贴板文本过大")

// Read returns the system clipboard's text, which is empty when the clipboard
// holds something that is not text.
func Read(ctx context.Context) (string, error) {
	return read(ctx, runtime.GOOS)
}

// Write replaces the system clipboard's text.
func Write(ctx context.Context, text string) error {
	return write(ctx, runtime.GOOS, text)
}

func read(ctx context.Context, goos string) (string, error) {
	candidates := readCommands(goos)
	if len(candidates) == 0 {
		return "", fmt.Errorf("当前平台不支持读取剪贴板：%s", goos)
	}
	var last error
	for _, argv := range candidates {
		out, err := run(ctx, argv, nil)
		if err == nil {
			return out, nil
		}
		if errors.Is(err, ErrTooLarge) {
			return "", err
		}
		last = err
	}
	return "", fmt.Errorf("读取剪贴板失败（已尝试 %s）：%w", commandNames(candidates), last)
}

func write(ctx context.Context, goos string, text string) error {
	candidates := writeCommands(goos)
	if len(candidates) == 0 {
		return fmt.Errorf("当前平台不支持写入剪贴板：%s", goos)
	}
	var last error
	for _, argv := range candidates {
		if _, err := run(ctx, argv, strings.NewReader(text)); err == nil {
			return nil
		} else {
			last = err
		}
	}
	return fmt.Errorf("写入剪贴板失败（已尝试 %s）：%w", commandNames(candidates), last)
}

// readCommands lists the platform's clipboard readers, most preferred first.
// Only one of the Linux tools is normally installed; the rest fail fast with
// exec.ErrNotFound and the next candidate takes over.
func readCommands(goos string) [][]string {
	switch goos {
	case "darwin":
		return [][]string{{"pbpaste"}}
	case "windows":
		return [][]string{{
			"powershell", "-NoProfile", "-NonInteractive", "-Command",
			"[Console]::Out.Write((Get-Clipboard -Raw))",
		}}
	case "linux", "freebsd", "openbsd", "netbsd":
		return [][]string{
			{"wl-paste", "--no-newline"},
			{"xclip", "-selection", "clipboard", "-o"},
			{"xsel", "--clipboard", "--output"},
		}
	}
	return nil
}

// writeCommands lists the platform's clipboard writers. Each forks into the
// background to keep serving the selection, so they return promptly.
func writeCommands(goos string) [][]string {
	switch goos {
	case "darwin":
		return [][]string{{"pbcopy"}}
	case "windows":
		return [][]string{{
			"powershell", "-NoProfile", "-NonInteractive", "-Command",
			"$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
		}}
	case "linux", "freebsd", "openbsd", "netbsd":
		return [][]string{
			{"wl-copy"},
			{"xclip", "-selection", "clipboard", "-i"},
			{"xsel", "--clipboard", "--input"},
		}
	}
	return nil
}

func commandNames(candidates [][]string) string {
	names := make([]string, 0, len(candidates))
	for _, argv := range candidates {
		names = append(names, argv[0])
	}
	return strings.Join(names, "/")
}

func run(ctx context.Context, argv []string, stdin io.Reader) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, argv[0], argv[1:]...)
	cmd.Stdin = stdin
	stdout := &limitedBuffer{limit: MaxTextBytes}
	var stderr bytes.Buffer
	cmd.Stdout = stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if stdout.overflow {
		return "", ErrTooLarge
	}
	if err != nil {
		if reason := strings.TrimSpace(stderr.String()); reason != "" {
			return "", fmt.Errorf("%s: %w: %s", argv[0], err, reason)
		}
		return "", fmt.Errorf("%s: %w", argv[0], err)
	}
	return stdout.String(), nil
}

// limitedBuffer keeps a runaway clipboard (a whole log file, say) from crossing
// the RPC boundary without also stalling the child process on a full pipe.
type limitedBuffer struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	room := l.limit - l.buf.Len()
	if len(p) > room {
		l.overflow = true
		if room > 0 {
			l.buf.Write(p[:room])
		}
		return len(p), nil
	}
	return l.buf.Write(p)
}

func (l *limitedBuffer) String() string { return l.buf.String() }
