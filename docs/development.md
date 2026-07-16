# Raven Development

## API

Start LiveKit for local RTC:

```powershell
livekit-server --dev
```

`livekit-server` is a separate LiveKit media server process. It can be run from any directory as long as the executable is on `PATH`; it does not run from inside `services/api` or `apps/desktop`.

The API defaults to `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`, and `LIVEKIT_API_SECRET=secret`.

```powershell
cd services/api
go mod tidy
go run ./cmd/raven-api
```

Create the first admin:

```powershell
cd services/api
go run ./cmd/raven-api user create --username admin --password "admin123" --role admin
```

Run tests:

```powershell
cd services/api
go test ./...
```

Run the desktop updater and UI suites:

```powershell
cd apps\desktop
bun install --frozen-lockfile
bun test
bun run build

cd src-tauri
cargo fmt --all -- --check
cargo check
cargo test
```

Run operations and release-tooling validation:

```powershell
cd apps\operations
bun install --frozen-lockfile
bun test
bun run build

cd ..\..
.\release.ps1 test
```

Release preparation intentionally requires a clean committed HEAD. See `docs/update-release-runbook.md`; never copy the updater private key to a backend, Linux builder, object store, or deployment host.

## Desktop

```powershell
cd apps/desktop
bun install
bun run tauri dev
```

Build:

```powershell
cd apps/desktop
bun run build
bun run tauri build
```

## Notes

- Use Bun for all JavaScript and TypeScript package operations.
- The desktop app is not a browser meeting interface.
- Do not add public registration.
- Product UI should say Nest or Nests, not Room or Rooms.
