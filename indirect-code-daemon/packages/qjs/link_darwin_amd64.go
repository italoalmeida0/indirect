//go:build darwin && amd64

package qjs

/*
// The engine: the prebuilt Mach-O archive for this platform.
#cgo LDFLAGS: -L${SRCDIR}/lib/x86_64_macos -lquickjs -lm
*/
import "C"
