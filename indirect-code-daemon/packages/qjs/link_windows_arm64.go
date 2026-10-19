//go:build windows && arm64

package qjs

/*
#cgo LDFLAGS: -L${SRCDIR}/lib/aarch64_windows_gnu -lquickjs -lm
*/
import "C"
