// Copyright (c) 2017, Daniel Martí <mvdan@mvdan.cc>
// See LICENSE for licensing information

//go:build !js

package interp

import (
	"bytes"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

// stdinFile is the runner's standard input. It may be an [*os.File] or an
// in-memory pipe/reader supporting cancellable reads via SetReadDeadline.
type stdinFile = StdinPipe

// readerStdin adapts a plain [io.Reader] into a [stdinFile] without allocating
// an OS pipe or spawning a background copier goroutine.
type readerStdin struct {
	io.Reader
}

func (r readerStdin) Close() error {
	if c, ok := r.Reader.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

func (readerStdin) SetReadDeadline(t time.Time) error { return nil }

// newPipe returns a pipe for shell pipelines and here-documents, using the
// registered pooled in-memory pipe factory when available.
func newPipe() (stdinFile, io.WriteCloser, error) {
	if fn := customPipeFactory.Load(); fn != nil {
		return (*fn)()
	}
	return os.Pipe()
}

// newOSPipe returns a kernel OS pipe for cases where multiple sequential
// subprocesses in a compound pipeline stage must share a seek/read offset.
func newOSPipe() (stdinFile, io.WriteCloser, error) {
	return os.Pipe()
}

// newStdinFile converts a reader into the runner's stdin. [*os.File] and
// [StdinPipe] values are preserved directly, and finite in-memory readers avoid
// OS pipe allocation; arbitrary streaming readers use an OS pipe so external
// subprocesses inherit a real OS fd without blocking cmd.Wait().
func newStdinFile(r io.Reader) (stdinFile, error) {
	switch r := r.(type) {
	case nil:
		return nil, nil
	case stdinFile:
		return r, nil
	case *strings.Reader, *bytes.Reader, *bytes.Buffer:
		return readerStdin{r}, nil
	default:
		pr, pw, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		go func() {
			_, _ = io.Copy(pw, r)
			_ = pw.Close()
		}()
		return pr, nil
	}
}

// stdinTerminal returns the file descriptor of the shell's stdin
// if it is a terminal.
// Note that we only call [os.File.Fd] on character devices,
// as it stops [os.File.SetReadDeadline] from working,
// which [Runner.readLine] needs to cancel blocking reads.
func stdinTerminal(stdin stdinFile) (int, bool) {
	f, ok := stdin.(*os.File)
	if !ok || f == nil {
		return -1, false
	}
	fi, err := f.Stat()
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return -1, false
	}
	fd := int(f.Fd())
	return fd, term.IsTerminal(fd)
}
