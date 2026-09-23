# TLS test fixtures

Used by `../system-ca.integration.test.ts` to run a real HTTPS / WSS handshake against a
certificate chain that Node's bundled roots do NOT trust — the same situation as a corporate
TLS-inspection proxy whose root CA lives only in the OS store.

- `test-ca.pem` — self-signed test root CA (key discarded after signing).
- `test-server.pem` / `test-server.key` — leaf for `localhost` / `127.0.0.1`, signed by the CA.

Both are valid for 100 years. They are test-only and trusted by nothing outside that test.

Regenerate (all three files together):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-ca.key -out test-ca.pem -days 36500 \
  -subj "/CN=strIDEterm Test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout test-server.key -out test-server.csr -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in test-server.csr -CA test-ca.pem -CAkey test-ca.key -CAcreateserial \
  -out test-server.pem -days 36500 -extfile ext.cnf
rm test-server.csr ext.cnf test-ca.key test-ca.srl
```

(On Git Bash for Windows prefix each `openssl` with `MSYS_NO_PATHCONV=1` so `-subj` isn't mangled.)
