//go:build windows && amd64

package qjs

/*
#cgo LDFLAGS: -L${SRCDIR}/lib/x86_64_windows_gnu -lquickjs -lm
*/
import "C"
