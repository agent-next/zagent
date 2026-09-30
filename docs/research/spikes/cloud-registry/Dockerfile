# The fuzz agent: one round of random human journeys, then exit. Measured 54 MiB
# peak RSS and ~1% CPU of wall time, which is why `lite` (1/16 vCPU, 256 MiB) is
# the right instance type and why a thousand of these cost ~$67/day.
FROM node:22-slim
WORKDIR /app
# The published artifact only — this image never carries repo history.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY packages ./packages
COPY scripts ./scripts
ENV FUZZ_ITERATIONS=40
# One round, then die. Ephemeral disk is fine because every finding was already
# claimed and uploaded to the registry before this process exits.
CMD ["sh","-c","node scripts/journey-fuzz.mjs --iterations $FUZZ_ITERATIONS --seed $RANDOM$RANDOM; echo round done exit=$?"]
