// Cross-verifies the repo's RSABSSA test vectors against CIRCL, an independent
// RFC 9474 implementation, so wallet authors can trust either side.
//
//	go run ./tools/circl-crossverify -mode verify -file test-vectors/rsabssa-sha384-pss-randomized.json
//	go run ./tools/circl-crossverify -mode generate -count 3
//
// CIRCL's Client.Finalize takes an opaque State, so a stored inv cannot be fed
// back in here. Go therefore checks the two operations that are reproducible
// from recorded bytes alone: BlindSign must reproduce blind_sig exactly, and
// the finalized sig must verify. Finalize-from-inv is checked on the
// TypeScript side, where the API accepts inv directly.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

const suiteName = "RSABSSA-SHA384-PSS-Randomized"

type vector struct {
	Name            string `json:"name"`
	Origin          string `json:"origin"`
	ModulusBits     int    `json:"modulus_bits"`
	PrivateKeyPKCS8 string `json:"private_key_pkcs8"`
	PublicKeySPKI   string `json:"public_key_spki"`
	PreparedMsg     string `json:"prepared_msg"`
	BlindedMsg      string `json:"blinded_msg"`
	BlindSig        string `json:"blind_sig"`
	Inv             string `json:"inv,omitempty"`
	Sig             string `json:"sig"`
}

type vectorFile struct {
	Suite   string   `json:"suite"`
	Vectors []vector `json:"vectors"`
}

func mustHex(t, field, value string) []byte {
	raw, err := hex.DecodeString(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %s is not hex: %v\n", t, field, err)
		os.Exit(1)
	}
	return raw
}

func privateKey(v vector) *rsa.PrivateKey {
	parsed, err := x509.ParsePKCS8PrivateKey(mustHex(v.Name, "private_key_pkcs8", v.PrivateKeyPKCS8))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: bad PKCS#8: %v\n", v.Name, err)
		os.Exit(1)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		fmt.Fprintf(os.Stderr, "%s: not an RSA private key\n", v.Name)
		os.Exit(1)
	}
	return key
}

func publicKey(v vector) *rsa.PublicKey {
	parsed, err := x509.ParsePKIXPublicKey(mustHex(v.Name, "public_key_spki", v.PublicKeySPKI))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: bad SPKI: %v\n", v.Name, err)
		os.Exit(1)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		fmt.Fprintf(os.Stderr, "%s: not an RSA public key\n", v.Name)
		os.Exit(1)
	}
	return key
}

func verify(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot read %s: %v\n", path, err)
		return 2
	}
	var file vectorFile
	if err := json.Unmarshal(raw, &file); err != nil {
		fmt.Fprintf(os.Stderr, "cannot parse %s: %v\n", path, err)
		return 2
	}
	if file.Suite != suiteName {
		fmt.Fprintf(os.Stderr, "expected suite %s, got %s\n", suiteName, file.Suite)
		return 2
	}
	if len(file.Vectors) == 0 {
		fmt.Fprintln(os.Stderr, "no vectors to check")
		return 2
	}

	failures := 0
	origins := map[string]int{}
	for _, v := range file.Vectors {
		origins[v.Origin]++

		signer := blindrsa.NewSigner(privateKey(v))
		blindSig, err := signer.BlindSign(mustHex(v.Name, "blinded_msg", v.BlindedMsg))
		if err != nil {
			fmt.Printf("FAIL %s: BlindSign errored: %v\n", v.Name, err)
			failures++
			continue
		}
		if hex.EncodeToString(blindSig) != v.BlindSig {
			fmt.Printf("FAIL %s: BlindSign output differs from blind_sig\n", v.Name)
			failures++
			continue
		}

		verifier, err := blindrsa.NewVerifier(blindrsa.SHA384PSSRandomized, publicKey(v))
		if err != nil {
			fmt.Printf("FAIL %s: NewVerifier: %v\n", v.Name, err)
			failures++
			continue
		}
		if err := verifier.Verify(mustHex(v.Name, "prepared_msg", v.PreparedMsg), mustHex(v.Name, "sig", v.Sig)); err != nil {
			fmt.Printf("FAIL %s: signature does not verify: %v\n", v.Name, err)
			failures++
			continue
		}
		fmt.Printf("ok   %s (%s): BlindSign reproduces blind_sig, sig verifies\n", v.Name, v.Origin)
	}

	fmt.Printf("\n%d vectors checked against CIRCL", len(file.Vectors))
	for origin, count := range origins {
		fmt.Printf(", %d from %s", count, origin)
	}
	fmt.Println()

	if failures > 0 {
		fmt.Fprintf(os.Stderr, "%d vector(s) failed\n", failures)
		return 1
	}
	return 0
}

func generate(count int) int {
	vectors := make([]vector, 0, count)
	for i := 0; i < count; i++ {
		sk, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			fmt.Fprintf(os.Stderr, "keygen: %v\n", err)
			return 2
		}
		c, err := blindrsa.NewClient(blindrsa.SHA384PSSRandomized, &sk.PublicKey)
		if err != nil {
			fmt.Fprintf(os.Stderr, "NewClient: %v\n", err)
			return 2
		}

		prepared, err := c.Prepare(rand.Reader, []byte(fmt.Sprintf("anyone-credential-serial-%d", i)))
		if err != nil {
			fmt.Fprintf(os.Stderr, "Prepare: %v\n", err)
			return 2
		}
		blindedMsg, state, err := c.Blind(rand.Reader, prepared)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Blind: %v\n", err)
			return 2
		}
		blindSig, err := blindrsa.NewSigner(sk).BlindSign(blindedMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "BlindSign: %v\n", err)
			return 2
		}
		sig, err := c.Finalize(state, blindSig)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Finalize: %v\n", err)
			return 2
		}

		pkcs8, err := x509.MarshalPKCS8PrivateKey(sk)
		if err != nil {
			fmt.Fprintf(os.Stderr, "MarshalPKCS8: %v\n", err)
			return 2
		}
		spki, err := x509.MarshalPKIXPublicKey(&sk.PublicKey)
		if err != nil {
			fmt.Fprintf(os.Stderr, "MarshalPKIX: %v\n", err)
			return 2
		}

		vectors = append(vectors, vector{
			Name:            fmt.Sprintf("circl-%d", i),
			Origin:          "circl-go",
			ModulusBits:     2048,
			PrivateKeyPKCS8: hex.EncodeToString(pkcs8),
			PublicKeySPKI:   hex.EncodeToString(spki),
			PreparedMsg:     hex.EncodeToString(prepared),
			BlindedMsg:      hex.EncodeToString(blindedMsg),
			BlindSig:        hex.EncodeToString(blindSig),
			Sig:             hex.EncodeToString(sig),
		})
	}

	out, err := json.MarshalIndent(vectors, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		return 2
	}
	fmt.Println(string(out))
	return 0
}

func main() {
	mode := flag.String("mode", "verify", "verify | generate")
	file := flag.String("file", "test-vectors/rsabssa-sha384-pss-randomized.json", "vector file to verify")
	count := flag.Int("count", 3, "vectors to generate")
	flag.Parse()

	switch *mode {
	case "verify":
		os.Exit(verify(*file))
	case "generate":
		os.Exit(generate(*count))
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", *mode)
		os.Exit(2)
	}
}
