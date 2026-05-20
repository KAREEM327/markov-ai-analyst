FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager used by the analysis script)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Pre-warm uv's Python environment — installs numpy, pandas, yfinance, etc.
# into the uv cache so the first real request isn't slow.
# The data fetch may or may not succeed here; either way the packages are cached.
RUN uv run scripts/markov_regime.py --ticker MSFT --json --no-hmm || true

# Build Next.js for production
RUN npm run build

EXPOSE 3000

ENV NODE_ENV=production

# Railway injects PORT — Next.js reads it automatically
CMD ["sh", "-c", "node_modules/.bin/next start -p ${PORT:-3000}"]
