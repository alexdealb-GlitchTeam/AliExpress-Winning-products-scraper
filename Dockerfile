# Apify Actor Docker image
# Uses the official Apify Playwright image which includes chromium + stealth patches
FROM apify/actor-node-playwright-chrome:18

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . ./

# Run the Actor
CMD npm start
