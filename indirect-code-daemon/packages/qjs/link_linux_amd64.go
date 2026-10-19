//go:build linux && amd64

package qjs

/*
#cgo LDFLAGS: -L${SRCDIR}/lib/x86_64_linux_musl -lquickjs -lm -lpthread
*/
import "C"
