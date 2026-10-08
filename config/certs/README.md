# Public Supabase database CA

`supabase-prod-ca-2021.crt` is the public **Supabase Root 2021 CA** certificate.
It contains no private key or project credential. Downloaded on 2026-10-07 from
[Supabase's production certificate URL](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt),
as selected by the official dashboard's
[`ssl:certificate_url` configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json).
Supabase documents CA trust and full verification in its
[TLS guidance](https://supabase.com/docs/guides/platform/ssl-enforcement).

- PEM file SHA256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`
- Certificate SHA256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- Validity: 2021-04-28 10:56:53 UTC through 2031-04-26 10:56:53 UTC.

From the repository root, start the local app with:

```sh
NODE_EXTRA_CA_CERTS="$PWD/config/certs/supabase-prod-ca-2021.crt" node scripts/agent-local.mjs start
```

Use the documented Node 24 installation first. Keep `sslmode=verify-full` in the
privately configured database URL. The app retains certificate-chain and hostname
verification; this setting adds CA trust for the launched Node processes without
changing the system trust store. Node reads `NODE_EXTRA_CA_CERTS` at process
startup, so setting it only in a subsequently loaded dotenv file is insufficient
for that process. The Python worker does not connect directly to Postgres.

To inspect this public certificate:

```sh
shasum -a 256 config/certs/supabase-prod-ca-2021.crt
openssl x509 -in config/certs/supabase-prod-ca-2021.crt -noout -subject -issuer -dates -fingerprint -sha256
```

If Supabase rotates its CA, verify the replacement against its official dashboard
and documentation, update this file and fingerprints, and repeat the loopback
health check. Do not disable TLS verification or trust an unverified certificate
presented by a failed connection.
