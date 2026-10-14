// OpenDX launcher; the server implementation remains the exact Apache upstream.
package main

import (
	immudb "github.com/codenotary/immudb/cmd/immudb/command"
	"net"
	"os"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "health" {
		port := os.Getenv("IMMUDB_PORT")
		if port == "" {
			port = "3322"
		}
		connection, err := net.DialTimeout("tcp", "127.0.0.1:"+port, 2*time.Second)
		if err != nil {
			os.Exit(1)
		}
		_ = connection.Close()
		return
	}
	immudb.Execute()
}
