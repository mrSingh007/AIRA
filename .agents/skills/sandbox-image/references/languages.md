# Language examples

These recipes extend the provided `kangentix-sandbox:local` image, retaining Node/npm, Claude Code, Python, Git, and baseline libraries. Install only the tools needed by the target repository. Preserve `USER node` after build-time installation; Kangentix still enforces numeric UID:GID 1000:1000 at runtime.

## Java

This example fits a repository requiring Java 17 on the baseline's Debian Bookworm distribution:

```dockerfile
FROM kangentix-sandbox:local
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /tmp
```

Check `pom.xml`, Gradle toolchains, `.java-version`, CI, and wrapper configuration before selecting the JDK. For another Java version, use a compatible installation source and pin its version; do not assume the baseline's apt repositories offer it. Ensure both `java` and `javac` are accessible on `PATH`; set `JAVA_HOME` to the actual installation location when the project's tooling requires it.

Prefer checked-in `mvnw` or `gradlew` when present: their configuration selects the build-tool distribution. Make sure they can download or access that distribution and create caches under the writable home. If no wrapper exists, install the Maven or Gradle version required by the repository during image build. Apt's version is suitable only if it matches those requirements. Do not install both build tools unless the project needs both.

For runtime verification, add `java -version`, `javac -version`, and the selected wrapper/tool's version command. Maven's default `$HOME/.m2` and Gradle's `$HOME/.gradle` are writable because Kangentix supplies a disposable home. Bake read-only dependencies into a separate image directory only when useful, and arrange for runtime tools to copy/use them without writing into that directory.

## Python with uv

The baseline already supplies `python3` for Kangentix's runner. Inspect `pyproject.toml`, `.python-version`, `uv.lock`, requirements, and CI to choose the target Python version and manager. The baseline's Python version may differ from the target repository's requirement.

For a uv project compatible with the baseline Python, this Dockerfile requires an explicit uv version as a build argument:

```dockerfile
FROM kangentix-sandbox:local
USER root
ARG UV_VERSION
RUN test -n "$UV_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/kangentix-uv \
    && /opt/kangentix-uv/bin/pip install --no-cache-dir "uv==${UV_VERSION}" \
    && ln -s /opt/kangentix-uv/bin/uv /usr/local/bin/uv
USER node
WORKDIR /tmp
```

Build with `--build-arg UV_VERSION=<version-required-by-the-project>`. Choose that value from the project's tool configuration or CI, or document the deliberate version selection if it is unspecified. Add `uv --version` to runtime verification. The tool's installation under `/opt` is read-only at runtime; project environments and caches belong in `/tmp/kangentix/repo/.venv` and the disposable home.

If the target needs another Python version, install it while building the image and expose it to the project's manager. For uv-managed interpreters, configure `UV_PYTHON_INSTALL_DIR` to the actual preinstalled directory so uv can discover them; use a writable directory under `/tmp` for runtime downloads if downloads are intended. Avoid requiring uv to modify a read-only interpreter installation.

For pip projects, install `python3-venv` and use a virtual environment inside the disposable checkout; uv is unnecessary. Add compiler and development libraries when native Python dependencies require them. Verify installation and the repository's actual tests with the selected interpreter, rather than only checking the system Python used by Kangentix.
