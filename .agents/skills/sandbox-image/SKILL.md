---
name: sandbox-image
description: Create or adjust Docker sandbox images for Kangentix agent runs, choosing project runtimes and build tools and verifying compatibility with Kangentix's restricted sandbox. Use when a repository needs Java, Python, or other tooling beyond the provided Node image.
---

# Kangentix sandbox images

Produce a Dockerfile, build command, and configuration instructions suited to the repository the agent will work on. Start from Kangentix's Node-based `sandbox/Dockerfile`; changing the project's language does not remove Kangentix's own runtime requirements.

## Inspect before choosing tools

- Read `sandbox/Dockerfile`, `src/server/sandbox.ts`, `sandbox/runner.py`, and Compose configuration in this Kangentix checkout for the current runtime contract.
- Inspect the target repository's manifests, lockfiles, CI, wrappers, and version files. Choose runtime and tool versions from those files, rather than assuming the newest version is compatible.
- For Java, determine the JDK version and whether the project uses Maven, Gradle, or a checked-in wrapper. For Python, determine the Python version and whether it uses uv, pip, Poetry, or another manager. Install uv when the repository uses it; Python alone does not require uv.
- Include native libraries, compilers, browser dependencies, or system utilities required by the target project's build and tests. Preserve baseline packages needed by existing Kangentix workflows when extending the image.

## Runtime contract

- Keep Node.js and npm for Claude Code, the `claude` executable on `PATH`, Git for snapshot/export operations, Python 3.10+ for `runner.py`, and CA certificates for HTTPS. Keep the basic shell, `sleep`, `mkdir`, and `cat` utilities used by orchestration. The provided image includes these.
- Docker runs the image as UID:GID `1000:1000`, overrides its entrypoint with `sleep`, and makes the root filesystem read-only. A custom entrypoint cannot perform required setup.
- `/tmp` is a writable, executable, disposable tmpfs with a 2 GiB limit. `HOME=/tmp/kangentix-home`, `TMPDIR=/tmp`, and the working repository is `/tmp/kangentix/repo`. The default limits also include 4 GiB RAM, two CPUs, and 256 processes; consult the implementation if these change.
- Install system runtimes and global tools at image-build time in readable/executable locations. Runtime commands cannot use root, apt, or write to `/usr`, `/opt`, or the original user's home. Keep caches, virtual environments, generated outputs, and downloads under `/tmp`; tools using `$HOME` naturally use the disposable home.
- Do not bake credentials, private package tokens, user configuration, or target repository secrets into image layers. Kangentix transfers the checkout and runner separately for each run.

Read [language examples](references/languages.md) when adding Java or Python. Adapt them to the actual project; they are examples, not a requirement to install both languages.

## Build, verify, and select

Use a distinct custom image tag. Build the supplied baseline if needed, then build the custom Dockerfile on the Docker daemon Kangentix uses. With the supplied Compose setup, this is the host daemon exposed through its Docker socket; an image built in a different Docker context will not be available there.

For example, after creating `sandbox/Dockerfile.custom`:

```sh
docker build -t kangentix-sandbox:local -f sandbox/Dockerfile .
docker build -t kangentix-sandbox:custom -f sandbox/Dockerfile.custom .
```

Verify tool availability under runtime restrictions, not only as root during the build:

```sh
docker run --rm --user 1000:1000 --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=256 --memory=4g --cpus=2 \
  --tmpfs /tmp:rw,exec,nosuid,size=2g,mode=1777 \
  --env HOME=/tmp/kangentix-home --env TMPDIR=/tmp --workdir /tmp \
  --entrypoint sh kangentix-sandbox:custom -c \
  'mkdir -p "$HOME" && node --version && npm --version && claude --version && python3 --version && git --version'
```

Add checks for the selected language and package manager, and a representative build/test in a disposable checkout when available. Build only when requested or within the task's authorized scope; report unexecuted checks accurately.

In the project's **Config → Agent sandbox** settings, select **Docker** and set **Docker image** to the exact tag built above. Kangentix resolves the project image first, then `SANDBOX_DOCKER_IMAGE`, then `kangentix-sandbox:local`. Changing the app's own Dockerfile does not change the agent sandbox image.

If the user chooses E2B instead, use the project's **E2B** provider, API key, and template configuration. A local Docker image tag is not an E2B template; prepare the equivalent tools in the chosen E2B template. Keep this skill scoped to the requested image and instructions rather than changing existing project settings automatically.
