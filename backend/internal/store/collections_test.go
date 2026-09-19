package store

import (
	"path/filepath"
	"testing"
)

func newTestCollections(t *testing.T) *Collections {
	t.Helper()
	return NewCollections(filepath.Join(t.TempDir(), "collections.json"))
}

func seedTree(t *testing.T, c *Collections, conn string) {
	t.Helper()
	for _, node := range []Node{
		{Type: "folder", Name: "用户"},
		{Type: "request", Name: "登录", ParentID: "__quick__", Method: "POST"},
	} {
		if _, _, e := c.Save(conn, node); e != nil {
			t.Fatalf("seed %s: %v", node.Name, e)
		}
	}
	items, e := c.List(conn)
	if e != nil {
		t.Fatal(e)
	}
	for _, node := range items {
		if node.Name == "用户" {
			for _, name := range []string{"列表", "详情"} {
				if _, _, e := c.Save(conn, Node{Type: "request", Name: name, ParentID: node.ID, Method: "GET"}); e != nil {
					t.Fatalf("seed %s: %v", name, e)
				}
			}
			return
		}
	}
	t.Fatal("seeded folder not found")
}

func findByName(items []Node, name string) Node {
	for _, node := range items {
		if node.Name == name {
			return node
		}
	}
	return Node{}
}

func idsOf(items []Node, parentID string) []string {
	var out []string
	for _, node := range items {
		if node.ParentID == parentID {
			out = append(out, node.ID)
		}
	}
	return out
}

func TestSaveAppendsOrderForNewNodes(t *testing.T) {
	c := newTestCollections(t)
	const conn = "c1"
	seedTree(t, c, conn)
	items, e := c.List(conn)
	if e != nil {
		t.Fatal(e)
	}
	if len(idsOf(items, "")) != 1 {
		t.Fatalf("expected one root node, got %d", len(idsOf(items, "")))
	}
	if _, _, e := c.Save(conn, Node{Type: "request", Name: "根请求", Method: "GET"}); e != nil {
		t.Fatal(e)
	}
	items, _ = c.List(conn)
	roots := idsOf(items, "")
	if len(roots) != 2 {
		t.Fatalf("expected two root nodes, got %d", len(roots))
	}
	// The new node lands after the existing one, whatever its name is.
	if findByName(items, "根请求").ID != roots[len(roots)-1] {
		t.Fatal("new node did not append to the end of its siblings")
	}
}

func TestReorderPinsSiblingOrder(t *testing.T) {
	c := newTestCollections(t)
	const conn = "c1"
	seedTree(t, c, conn)
	items, _ := c.List(conn)
	folder := findByName(items, "用户")
	children := idsOf(items, folder.ID)
	if len(children) != 2 {
		t.Fatalf("expected two children, got %d", len(children))
	}
	// Reverse the folder's children.
	turned := []string{children[1], children[0]}
	got, e := c.Reorder(conn, folder.ID, turned)
	if e != nil {
		t.Fatal(e)
	}
	folderAfter := findByName(got, "用户")
	var ordered []string
	for _, node := range got {
		if node.ParentID == folderAfter.ID {
			ordered = append(ordered, node.ID)
		}
	}
	if ordered[0] != turned[0] || ordered[1] != turned[1] {
		t.Fatalf("reorder not persisted: %v", ordered)
	}
}

func TestReorderRejectsForeignNodes(t *testing.T) {
	c := newTestCollections(t)
	const conn = "c1"
	seedTree(t, c, conn)
	items, _ := c.List(conn)
	folder := findByName(items, "用户")
	quick := findByName(items, "登录")
	if quick.ParentID != QuickRootID {
		t.Fatalf("seed mistake: %q should be quick", quick.Name)
	}
	// A quick request cannot be ordered among the folder's children.
	if _, e := c.Reorder(conn, folder.ID, []string{quick.ID}); e == nil {
		t.Fatal("expected cross-group reorder to fail")
	}
	// Neither can a node be listed twice.
	children := idsOf(items, folder.ID)
	if _, e := c.Reorder(conn, folder.ID, []string{children[0], children[0]}); e == nil {
		t.Fatal("expected duplicate id to fail")
	}
}

func TestReorderKeepsFoldersAheadOfRequests(t *testing.T) {
	c := newTestCollections(t)
	const conn = "c1"
	seedTree(t, c, conn)
	if _, _, e := c.Save(conn, Node{Type: "request", Name: "根请求", Method: "GET"}); e != nil {
		t.Fatal(e)
	}
	items, _ := c.List(conn)
	folder := findByName(items, "用户")
	root := findByName(items, "根请求")
	// The client sent the request first; the backend must still pin the
	// folder ahead of it.
	got, e := c.Reorder(conn, "", []string{root.ID, folder.ID})
	if e != nil {
		t.Fatal(e)
	}
	if findByName(got, "用户").Order >= findByName(got, "根请求").Order {
		t.Fatalf("folder must sort ahead of requests: folder=%v request=%v",
			findByName(got, "用户").Order, findByName(got, "根请求").Order)
	}
}

func TestMoveRejectsFolderIntoItself(t *testing.T) {
	c := newTestCollections(t)
	const conn = "c1"
	seedTree(t, c, conn)
	items, _ := c.List(conn)
	folder := findByName(items, "用户")
	if _, _, e := c.Save(conn, Node{ID: folder.ID, ParentID: folder.ID, Type: "folder", Name: folder.Name}); e == nil {
		t.Fatal("expected move into itself to fail")
	}
}
