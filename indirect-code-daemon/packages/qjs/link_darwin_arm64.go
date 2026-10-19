//go:build darwin && arm64

package qjs

/*
// The engine: the prebuilt Mach-O archive for this platform.
#cgo LDFLAGS: -L${SRCDIR}/lib/aarch64_macos -lquickjs -lm

// libresolv: Go's net package links -lresolv on darwin, but a cross link
// from linux has no macOS SDK to satisfy it. macos_link_stubs/aarch64_macos carries a
// tiny real Mach-O archive defining the resolver entry points Go asks for,
// so the link resolves; on macOS itself these also come from libSystem.
#cgo LDFLAGS: -L${SRCDIR}/lib/macos_link_stubs/aarch64_macos -lresolv
*/
import "C"
