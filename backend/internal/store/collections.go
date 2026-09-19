package store

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
)

// Node is one entry of the API collection tree: a folder or a saved request.
type Node struct {
	ID          string         `json:"id"`
	ParentID    string         `json:"parentId,omitempty"`
	Type        string         `json:"type"` // folder|request
	Name        string         `json:"name"`
	Method      string         `json:"method,omitempty"`
	URL         string         `json:"url,omitempty"`
	Headers     []rest.KV      `json:"headers,omitempty"`
	QueryParams []rest.KV      `json:"queryParams,omitempty"`
	Body        *rest.BodySpec `json:"body,omitempty"`
	Auth        *rest.AuthSpec `json:"auth,omitempty"`
	Settings    *rest.Settings `json:"settings,omitempty"`
	Description string         `json:"description,omitempty"`
	// Order positions a node among its siblings; 0 (the zero value) is the
	// legacy "never explicitly ordered" marker and sorts first.
	Order     float64   `json:"order,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// QuickRootID is the reserved virtual parent for quick-saved requests. It is
// not a real node: quick requests live outside the folder tree and the UI
// renders them under their own group.
const QuickRootID = "__quick__"

// Collections persists the request tree per connection.
type Collections struct {
	mu    sync.Mutex
	path  string
	items map[string]map[string]Node
}

// NewCollections targets an explicit file; an empty path falls back to the
// default user config location.
func NewCollections(path string) *Collections { return &Collections{path: path} }

func (c *Collections) ensure() error {
	if c.items != nil {
		return nil
	}
	if c.path == "" {
		path, err := DefaultPath("collections.json")
		if err != nil {
			return err
		}
		c.path = path
	}
	items := map[string]map[string]Node{}
	if err := Load(c.path, &items); err != nil {
		return err
	}
	c.items = items
	return nil
}

func (c *Collections) List(connID string) ([]Node, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	return sortedNodes(c.items[connID]), nil
}

// Save upserts a node and returns it (with its assigned ID) alongside the
// full list. New nodes get an ID; moving a node under its own descendant is
// rejected to keep the tree acyclic. A node whose parent is the reserved
// QuickRootID skips parent validation: quick requests live outside the tree.
func (c *Collections) Save(connID string, node Node) (Node, []Node, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return Node{}, nil, err
	}
	node.Name = strings.TrimSpace(node.Name)
	if node.Name == "" {
		return Node{}, nil, errors.New("名称不能为空")
	}
	if node.Type != "folder" && node.Type != "request" {
		return Node{}, nil, errors.New("类型必须是 folder 或 request")
	}
	if node.Type == "request" && node.Method == "" {
		node.Method = "GET"
	}
	node.Method = strings.ToUpper(node.Method)
	existing := c.items[connID]
	if existing == nil {
		existing = map[string]Node{}
		c.items[connID] = existing
	}
	if node.ID == "" {
		node.ID = NewID()
		node.CreatedAt = time.Now()
	} else if current, ok := existing[node.ID]; ok {
		node.CreatedAt = current.CreatedAt
	} else {
		node.CreatedAt = time.Now()
	}
	if node.ParentID != "" && node.ParentID != QuickRootID {
		parent, ok := existing[node.ParentID]
		if !ok {
			return Node{}, nil, errors.New("上级目录不存在")
		}
		if parent.Type != "folder" {
			return Node{}, nil, errors.New("上级必须是文件夹")
		}
		// Walk the parent itself first — a root folder has an empty ParentID,
		// and the old loop's condition skipped it, letting a root folder be
		// dropped into itself or one of its children.
		for cursor := parent; ; cursor = existing[cursor.ParentID] {
			if cursor.ID == node.ID {
				return Node{}, nil, errors.New("不能把目录移动到它自身内部")
			}
			if cursor.ParentID == "" {
				break
			}
		}
	}
	// A brand-new node, or one dropped into another parent, joins the end of
	// its siblings; an explicit drag order arrives via Reorder afterwards.
	if node.ID == "" || nodeMoved(existing, node) {
		node.Order = nextSiblingOrder(existing, node.ParentID)
	}
	node.UpdatedAt = time.Now()
	next := make(map[string]map[string]Node, len(c.items)+1)
	for k, v := range c.items {
		next[k] = v
	}
	entries := make(map[string]Node, len(existing)+1)
	for k, v := range existing {
		entries[k] = v
	}
	entries[node.ID] = node
	next[connID] = entries
	// Commit memory only after the atomic disk write succeeds.
	if err := Save(c.path, next); err != nil {
		return Node{}, nil, err
	}
	c.items = next
	return node, sortedNodes(entries), nil
}

// Reorder pins the children of one parent to the exact order given by ids.
// Every id must already be a child of parentID — the tree, the quick group and
// a folder's children are reordered among themselves, never across groups.
func (c *Collections) Reorder(connID, parentID string, ids []string) ([]Node, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	existing := c.items[connID]
	if existing == nil {
		return nil, fmt.Errorf("连接 %s 没有集合", connID)
	}
	seen := make(map[string]bool, len(ids))
	orders := make(map[string]float64, len(ids))
	// Folders always sort ahead of requests: a client sending an interleaved
	// list gets it partitioned stably rather than an invariant-breaking write.
	var folderIDs, requestIDs []string
	for _, nodeID := range ids {
		node, ok := existing[nodeID]
		if !ok {
			return nil, fmt.Errorf("节点 %s 不存在", nodeID)
		}
		if node.ParentID != parentID {
			return nil, fmt.Errorf("节点 %s 不在同一个分组里", nodeID)
		}
		if seen[nodeID] {
			return nil, fmt.Errorf("节点 %s 重复出现", nodeID)
		}
		seen[nodeID] = true
		if node.Type == "folder" {
			folderIDs = append(folderIDs, nodeID)
		} else {
			requestIDs = append(requestIDs, nodeID)
		}
	}
	for i, nodeID := range append(folderIDs, requestIDs...) {
		orders[nodeID] = float64(i + 1)
	}
	next := make(map[string]map[string]Node, len(c.items)+1)
	for k, v := range c.items {
		next[k] = v
	}
	entries := make(map[string]Node, len(existing))
	for k, v := range existing {
		entry := v
		if order, ok := orders[k]; ok {
			entry.Order = order
			entry.UpdatedAt = time.Now()
		}
		entries[k] = entry
	}
	next[connID] = entries
	if err := Save(c.path, next); err != nil {
		return nil, err
	}
	c.items = next
	return sortedNodes(entries), nil
}

// nodeMoved reports whether node re-parents relative to the stored copy.
func nodeMoved(existing map[string]Node, node Node) bool {
	current, ok := existing[node.ID]
	return ok && current.ParentID != node.ParentID
}

// nextSiblingOrder is one past the largest order among a parent's children.
func nextSiblingOrder(existing map[string]Node, parentID string) float64 {
	var max float64
	for _, node := range existing {
		if node.ParentID == parentID && node.Order > max {
			max = node.Order
		}
	}
	return max + 1
}

// Delete removes a node and every descendant folder/request.
func (c *Collections) Delete(connID, id string) ([]Node, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	existing := c.items[connID]
	if existing == nil {
		return []Node{}, nil
	}
	if _, ok := existing[id]; !ok {
		return nil, fmt.Errorf("节点 %s 不存在", id)
	}
	children := map[string][]string{}
	for _, node := range existing {
		children[node.ParentID] = append(children[node.ParentID], node.ID)
	}
	doomed := map[string]bool{id: true}
	queue := []string{id}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, child := range children[current] {
			if !doomed[child] {
				doomed[child] = true
				queue = append(queue, child)
			}
		}
	}
	next := make(map[string]map[string]Node, len(c.items)+1)
	for k, v := range c.items {
		next[k] = v
	}
	entries := make(map[string]Node, len(existing))
	for k, v := range existing {
		if !doomed[k] {
			entries[k] = v
		}
	}
	next[connID] = entries
	if err := Save(c.path, next); err != nil {
		return nil, err
	}
	c.items = next
	return sortedNodes(entries), nil
}

func sortedNodes(items map[string]Node) []Node {
	out := make([]Node, 0, len(items))
	for _, node := range items {
		out = append(out, node)
	}
	sort.Slice(out, func(i, j int) bool {
		// Explicit drag order first; nodes never ordered keep creation order.
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out
}
