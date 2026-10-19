//go:build linux && arm64

package qjs

/*
#cgo LDFLAGS: -L${SRCDIR}/lib/aarch64_linux_musl -lquickjs -lm -lpthread
*/
import "C"
