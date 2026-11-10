//go:build darwin && arm64

package qjs

/*
// The engine: the prebuilt Mach-O archive for this platform.
#cgo LDFLAGS: -L${SRCDIR}/lib/aarch64_macos -lquickjs -lm
*/
import "C"
