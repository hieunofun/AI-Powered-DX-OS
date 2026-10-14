// Build provenance for modules actually linked into a Go binary. Standard
// CycloneDX 1.5 component hashes and original notices accompany each image.
package main

import (
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	binary, destination := os.Args[1], os.Args[2]
	if err := os.MkdirAll(destination, 0755); err != nil {
		panic(err)
	}
	info, err := buildinfo.ReadFile(binary)
	if err != nil {
		panic(err)
	}
	packages, err := exec.Command("go", "list", "-deps", "./...").Output()
	if err != nil {
		panic(err)
	}
	for _, name := range strings.Fields(string(packages)) {
		if strings.HasPrefix(name, "golang.org/x/crypto/openpgp") {
			panic("unmaintained OpenPGP must not enter ledger binaries")
		}
	}
	if err = os.WriteFile(filepath.Join(destination, "packages.txt"), packages, 0644); err != nil {
		panic(err)
	}
	components := []any{}
	for _, dependency := range info.Deps {
		selected := dependency
		if dependency.Replace != nil {
			selected = dependency.Replace
		}
		command := exec.Command("go", "list", "-m", "-json", selected.Path+"@"+selected.Version)
		raw, err := command.Output()
		if err != nil {
			panic(err)
		}
		var module struct{ Dir, Sum string }
		if json.Unmarshal(raw, &module) != nil || module.Dir == "" {
			panic("module directory unavailable")
		}
		notices := []string{}
		err = filepath.WalkDir(module.Dir, func(file string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			name := strings.ToLower(entry.Name())
			if !strings.HasPrefix(name, "license") && !strings.HasPrefix(name, "notice") && !strings.HasPrefix(name, "copying") {
				return nil
			}
			content, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(module.Dir, file)
			if err != nil {
				return err
			}
			target := filepath.Join(destination, "notices", selected.Path+"@"+selected.Version, relative)
			if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			if err = os.WriteFile(target, content, 0644); err != nil {
				return err
			}
			notices = append(notices, filepath.ToSlash(relative))
			return nil
		})
		if err != nil {
			panic(err)
		}
		if len(notices) == 0 {
			panic("missing notice: " + selected.Path)
		}
		components = append(components, map[string]any{"type": "library", "name": selected.Path, "version": selected.Version,
			"purl": "pkg:golang/" + selected.Path + "@" + selected.Version, "properties": []any{
				map[string]string{"name": "go.module.sum", "value": selected.Sum},
				map[string]string{"name": "opendx.notice.paths", "value": strings.Join(notices, ",")}}})
	}
	bytes, err := os.ReadFile(binary)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(bytes)
	bom := map[string]any{"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1, "components": components,
		"metadata": map[string]any{"component": map[string]any{"type": "application", "name": filepath.Base(binary),
			"hashes": []any{map[string]string{"alg": "SHA-256", "content": hex.EncodeToString(digest[:])}}},
			"properties": []any{map[string]string{"name": "go.toolchain", "value": info.GoVersion}}}}
	raw, err := json.MarshalIndent(bom, "", "  ")
	if err != nil {
		panic(err)
	}
	if err = os.WriteFile(filepath.Join(destination, "sbom.cdx.json"), append(raw, '\n'), 0644); err != nil {
		panic(err)
	}
	if err = os.WriteFile(filepath.Join(destination, "build.txt"), []byte(info.String()), 0644); err != nil {
		panic(err)
	}
	fmt.Printf("provenance: %d linked modules, binary %s\n", len(components), hex.EncodeToString(digest[:]))
}
