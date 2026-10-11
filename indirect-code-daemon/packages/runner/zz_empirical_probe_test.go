package runner

import (
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Empirical probe: concurrent broadcast cursor access (run loop vs setcursor).
func TestEmpiricalBroadcastCursorRace(t *testing.T) {
	dir := t.TempDir()
	out, err := os.OpenFile(filepath.Join(dir, "out.log"), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	b := newBroadcaster(out)
	done := make(chan struct{})
	go func() { b.run(); close(done) }()

	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	go func() {
		// drain the parent side so Send never blocks forever
		buf := make([]byte, 4096)
		for {
			if _, err := c2.Read(buf); err != nil {
				return
			}
		}
	}()
	conn := NewConn(c1)
	cur := int64(0)
	b.register(conn, &cur)

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			b.setcursor(conn, int64(i))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_, _ = out.Write([]byte("hello world\n"))
			time.Sleep(time.Millisecond)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			_ = b.size()
		}
	}()
	wg.Wait()
	b.kill()
	<-done
}
