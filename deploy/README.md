# Deployment source and verified preparation

These templates add a private API/worker and an independently authenticated admin origin without replacing the static wardrobe. They contain no account keys, node endpoints, passwords or generated photos. Generated deployment files, the catalog, model, virtual environment and runtime state stay out of Git.

## Rendered configuration

```sh
python3 deploy/render.py \
  --output "$PRIVATE_STAGE/config" \
  --web-root "$PUBLIC_RELEASE/public" \
  --backend-root "$BACKEND_RELEASE" \
  --data-root "$PRIVATE_STATE" \
  --runtime-env "$PRIVATE_SETTINGS/runtime.env" \
  --api-port 8765
node scripts/export-catalog.mjs --output "$BACKEND_RELEASE/catalog.json"
```

Provide absolute paths for these operator-selected locations. The renderer writes only its named files into the explicit output directory; review before installing. The catalog evaluates the existing trusted JavaScript catalog with Node and exports all 100 looks; the backend must not parse JavaScript itself.

The real regression commands already exercised for this preparation are:

```sh
node qa/regression-catalog-export.mjs
node qa/regression-deploy.mjs
```

Both have recorded failing-before-implementation and passing-after-implementation runs in the private development evidence. This is preparation evidence, **not proof that the API, worker or admin UI are running**.

## Host layout and service boundaries

- Public and admin content have distinct roots. Deploy only the explicit public build to `www.8882088.xyz`; do not copy backend code, configuration or data there.
- The application runs as its own service user on `127.0.0.1:8765`. The admin host has its own matching certificate, host-only credential and role-checked API. The public host returns 404 for admin API paths.
- The API and worker templates expect `backend.app:create_app --factory` and `python -m backend.worker`. Verify the implemented launch contract and environment settings before installation; the environment file is private, never a public artifact.
- Code/releases are read-only to the service user. Writable data is outside static roots. A dedicated virtual environment must use an interpreter readable under the units' `ProtectHome=true`, not a Python installation hidden in an operator home directory.
- `yixu-egress.service` is an independent transport client. Its private configuration must set `allow-lan: false`, `bind-address: 127.0.0.1` and mixed port 7890, with only the selected authorized outbound node and an explicit rule. Do not enable TUN, change host routes/firewall/global proxy variables, add direct fallback or replace an existing proxy service.
- Runtime configuration includes the project API key and proxy choice; administrator APIs must never return secret values. Do not use assistant credentials as the project's inference key.

Service templates deliberately do not introduce generation quotas, rate limits or monetary budgets. One worker is a measured-host resource choice, not an application spending policy. Upload decoding and disk/resource safety remain required.

## Official model and binary evidence

YuNet was retrieved from `opencv/opencv_zoo`, commit `48b10fa505aeb51fbd127fc60a5c660040e823b7`, file `models/face_detection_yunet/face_detection_yunet_2023mar.onnx`. The downloaded 232589-byte ONNX matches the commit's Git LFS SHA-256:

```text
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
```

Keep the model's MIT license with the private deployment artifact. The real local detector found one face in each of the nine selected panels of the first existing public reference image, and no face in a blank control. This validates the actual model loading/inference boundary, not real-user photo quality or the backend integration.

The independently downloaded official `MetaCubeX/mihomo` release `v1.19.32`, asset `mihomo-linux-amd64-compatible-v1.19.32.gz`, was checked against its GitHub asset digest, then decompressed and hashed:

```text
compressed SHA-256: ba3ce607747a07f948fc35780e108a4a7c7f552a38b9bd4d115f313ebcb89c20
binary SHA-256:     7a0d59da2e678d56c899a3db996a2ad8963286c4f3634b0451435db248f13fa1
```

Actual node credentials and source inventory remain only in private operator files. A successful unauthenticated `/v1/models` HTTPS request through this explicit proxy returned 401; that proves transport/TLS reachability, **not project-key authorization, model availability, regional eligibility or a successful image generation**.

## Required cutover checks

Before replacing live application configuration:

1. Run all implemented backend, public UI, admin UI and retained-gallery tests; test actual uploads/detector paths, persistent queue restart, unknown-call no-replay and storage cleanup. Keep fake-provider tests distinct from real service calls.
2. Stage an explicit immutable release and its own environment. Check ownership/modes and record existing public-build and unrelated service fingerprints. Do not include input photos in backups.
3. Verify rendered Nginx files with the real host's `nginx -t` and units with `systemd-analyze verify`. Preserve a rollback for only the changed application paths. Stop the owned worker at a controlled boundary before changing shared application code; do not restart unrelated services.
4. Confirm API/transport listeners are loopback only, supervisor restart/boot enablement, host-role isolation, admin/visitor login separation, safe Cookie attributes, non-cacheable private data, ownership checks and absence of any administrator original-photo API.
5. Verify trusted HTTPS with normal DNS for both domains, certificate SANs and the existing renewal timer/reload hook. The admin certificate was prepared successfully while its app route deliberately returned maintenance 503 and the unchanged main site returned 200. This is TLS readiness, not finished admin deployment. Recheck the final application's body and status after cutover.
6. Verify all 200 original gallery image hashes and the original public interactions. Exercise phone and desktop layouts with actual browser input.
7. Configure an explicitly authorized project key through the private admin settings, then perform any paid photo-quality pilot only with explicit permission and consented inputs. Until then, expose an honest unavailable state, not fake images or an apparently successful end-to-end claim.

## Application CI and local verification

The existing Actions invocation of `node qa/regression-expressive.mjs` keeps the original gallery and asset checks and, under `GITHUB_ACTIONS=true`, invokes `scripts/verify-application.mjs`. No workflow permission expansion is required. The application runner performs locked Python dependency sync, backend tests, Ruff checks, type checking, parsed-admin DOM/HTTP tests, actual-frontend-to-ASGI integration, Chromium try-on tests, and catalog/deployment regressions. These tests never authorize a paid generation or use ambient project keys.

For the same entry point locally, run `node qa/regression-ci.mjs`. A real Chromium executable is required; use `CHROME_BIN` when it is not in a standard test location. Use a short private `CHROME_TMPDIR` if a long `TMPDIR` exceeds Chromium's UNIX socket path limit. If `uv` is absent the runner installs a pinned tool into a disposable virtual environment, not system Python. The detector comes from the pinned official URL and must match the hash above; an explicit `YIXU_TEST_FACE_MODEL` can reuse the already-verified model. The final deployment gate must include a real model run, not a skipped detector test.

These are three distinct evidence levels: synthetic-provider/API fixtures, real local handlers/model inference, and the deployed HTTPS service. Only an explicitly authorized paid pilot can establish actual provider quality; passing CI is not that pilot.

The private operations record owns real host addresses, node configuration, service state, credential-delivery paths, measured capacity, deployment receipts and rollback commands; they are intentionally absent from this public guide.
