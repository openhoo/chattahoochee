# Dependency audit

Reviewed: November 4, 2026.

Status: **Unresolved; not suppressed.**

## Finding

[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), also tracked as [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) and this repository's Dependabot alert 1, affects `glib >=0.15.0, <0.20.0`. The patched range is `>=0.20.0`. The advisory describes lifetime and null-pointer unsoundness in string-variant iterators, including `VariantStrIter`.

The repository locks `glib 0.18.5`, which falls within the affected range. Whether application execution can reach the vulnerable iterators has not been assessed.

## Checked dependency graph

The checked [Cargo.lock](../src-tauri/Cargo.lock) contains:

| Crate | Locked version |
| --- | --- |
| `tauri` | 2.11.5 |
| `tauri-runtime` | 2.11.3 |
| `tauri-runtime-wry` | 2.11.4 |
| `wry` | 0.55.1 |
| `muda` | 0.19.3 |
| `gtk` | 0.18.2 |
| `webkit2gtk` | 2.0.2 |
| `glib` | 0.18.5 |

Selected lockfile paths:

```text
chattahoochee 0.1.0
└─ tauri 2.11.5
   ├─ gtk 0.18.2 ────────── glib 0.18.5
   └─ webkit2gtk 2.0.2 ──── glib 0.18.5
```

The locked runtime, runtime-wry, Wry and Muda crates also introduce GTK or WebKit2GTK paths. Inspection of their exact installed manifests confirmed that these dependencies are gated to Linux, DragonFly BSD, FreeBSD, OpenBSD and NetBSD.

## Target evidence

The release scope is macOS and Windows. Target applicability and removal of the vulnerable package from the lockfile are separate findings.

| Target | Evidence and limitation |
| --- | --- |
| `aarch64-apple-darwin` | `cargo tree --locked --offline --target aarch64-apple-darwin -i glib` completed with “nothing to print”: GLib is absent from this active target graph. |
| `x86_64-pc-windows-msvc` | The inspected manifest conditions exclude the identified GTK/GLib paths. The equivalent offline tree query could not complete because `jiff-tzdb-platform 0.1.3` was uncached; no successful full Windows query is claimed. |
| `x86_64-unknown-linux-gnu` | The lockfile paths and manifest conditions establish an affected dependency graph. The offline tree query could not complete because `atk 0.18.2` was uncached. Linux runtime reachability was not tested. |

## Remediation status

No supported, compatible released Tauri upgrade that clears this graph was verified. The checked upstream development manifest identified itself as `2.12.5` and still required `gtk = "0.18"`; this observation does not establish a released fix. [Tauri issue 16264](https://github.com/tauri-apps/tauri/issues/16264), which discusses the GLib/GTK/WebKit migration, is closed, but that closure does not resolve the checked dependency graph.

Keep the advisory unresolved. Verify a compatible upstream release or an independently audited backport before marking it fixed. Forcing `glib 0.20` into the GTK 0.18 graph through a lockfile edit or arbitrary patch is not a verified compatible remediation. This audit made no Cargo dependency changes.

## Upstream reference

- [Tauri development Cargo manifest inspected for upgrade status](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/Cargo.toml)
