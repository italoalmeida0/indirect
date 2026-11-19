module indirect/indirect-code-daemon

go 1.26.11

require (
	github.com/gorilla/websocket v1.5.3
	github.com/italoalmeida0/btdby4 v0.0.0-20260916133140-b9fc87cf9fe9
	github.com/italoalmeida0/unish v1.2.0
	github.com/klauspost/compress v1.20.4
	github.com/sergi/go-diff v1.4.0
	golang.org/x/image v0.48.0
	golang.org/x/net v0.63.0
	golang.org/x/sys v0.50.0
	mvdan.cc/sh/v3 v3.14.1-0.20260909211640-962696198e2f
)

require golang.org/x/term v0.48.0 // indirect

replace mvdan.cc/sh/v3 => ./third_party/mvdan-sh
