package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The host rejects the handshake when the backend's announced version drifts
// from manifest.json — a plain constant went stale once already. These pin the
// manifest-wins resolution.
func TestResolveMetadataPrefersManifestVersion(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin", "darwin-arm64")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Stand in for the built sidecar: a file next to which the walk starts.
	if err := os.WriteFile(filepath.Join(binDir, "backend"), []byte("executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"io.dbx.nintyapi","version":"9.9.9","name":"NintyAPI"}`
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	m := resolveMetadataFromDir(binDir)
	if m.Version != "9.9.9" {
		t.Fatalf("manifest version must win, got %q", m.Version)
	}
	if m.ID != pluginID {
		t.Fatalf("id must stay %q, got %q", pluginID, m.ID)
	}
}

func TestResolveMetadataFallsBackWithoutManifest(t *testing.T) {
	m := resolveMetadataFromDir(t.TempDir())
	if m.Version != fallbackVersion {
		t.Fatalf("want fallback version %q, got %q", fallbackVersion, m.Version)
	}
}

func TestResolveMetadataIgnoresForeignManifest(t *testing.T) {
	root := t.TempDir()
	manifest := `{"id":"com.other.plugin","version":"7.7.7","name":"Other"}`
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	m := resolveMetadataFromDir(root)
	if m.Version != fallbackVersion {
		t.Fatalf("a foreign manifest must not set our version, got %q", m.Version)
	}
}
