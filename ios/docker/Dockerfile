# Linux Swift toolchain for running package tests on machines without Xcode.
# libsqlite3-dev is for CarbBookKit (GRDB); CarbBookCore needs nothing beyond the base image.
FROM swift:6.3.3-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*
