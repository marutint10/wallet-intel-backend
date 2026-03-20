# Product Specification: Wallet Intelligence Platform (Backend MVP)

## 1. Project Overview
[cite_start]This repository contains the NestJS backend for the Wallet Intelligence Platform[cite: 1]. [cite_start]The core objective is to allow users to paste any blockchain wallet address and instantly retrieve a complete intelligence report, including trading strategy, profit/loss history, token preferences, and AI-generated pattern analysis[cite: 6]. 

[cite_start]The architecture is built to support a simple, clean frontend [cite: 36] (Next.js) [cite_start]by aggregating on-chain data and processing it through an AI layer to produce human-readable insights[cite: 36].

## 2. Tech Stack (Backend)
* [cite_start]**Framework:** NestJS (Node.js) [cite: 36]
* [cite_start]**Blockchain Data Providers:** Moralis, Alchemy (or alternative RPCs/Indexers like Dune/The Graph) [cite: 36]
* [cite_start]**AI Integration:** OpenAI (GPT) or Anthropic (Claude) API [cite: 36]
* [cite_start]**Supported Chains (MVP):** Ethereum, Solana [cite: 36]

## 3. Core MVP Scope (Layer 1: Wallet Profiling)
[cite_start]The MVP strictly focuses on Layer 1 profiling to generate an instant report card for a queried wallet[cite: 19, 20].

### 3.1 Data Aggregation & Calculation Engine
The backend must fetch raw on-chain data and compute the following metrics:
* [cite_start]**PnL Calculation:** Calculate historical Profit and Loss for the wallet's trades[cite: 21].
* [cite_start]**Trade Metrics:** Compute the wallet's win rate and average hold time[cite: 21].
* [cite_start]**Behavioral Data:** Determine token preferences and calculate the ratio of DEX (Decentralized Exchange) vs. CEX (Centralized Exchange) behavior[cite: 22].

### 3.2 AI Summary Layer
[cite_start]The backend will format the aggregated metrics and send them to an AI API (Claude/GPT) to generate a human-readable trading strategy summary[cite: 8, 36].
* [cite_start]**Auto-Classification:** The AI must classify the wallet into categories such as: Swing trader, degen, long-term holder (HODLer), or bot[cite: 8, 23].

### 3.3 Access Control & Rate Limiting (Freemium Model)
To support the initial business model:
* [cite_start]Implement rate limiting to restrict unauthenticated or free-tier users to **3 free wallet lookups per day**[cite: 38]. 
* [cite_start]Prepare the architecture to support a "Pro Plan" ($19-$49/month) for unlimited lookups in the future[cite: 38].

## 4. API Endpoint Architecture (Proposed)

### `GET /api/v1/wallet/:address/report`
The primary endpoint for the frontend to consume. 
* **Query Params:** `?chain=eth|sol`
* **Workflow:**
    1. Validate wallet address format.
    2. [cite_start]Check rate limits (3/day threshold)[cite: 38].
    3. [cite_start]Fetch raw transaction/token data from Moralis/Alchemy[cite: 40].
    4. [cite_start]Compute PnL, win rate, and hold times[cite: 40].
    5. [cite_start]Pass structured data to Claude/GPT for the strategy summary[cite: 40].
    6. Return the unified JSON object to the Next.js frontend.

## 5. MVP Implementation Timeline
[cite_start]Based on the 4-week sprint plan[cite: 39]:

* **Week 1 (Data & Math):** Set up NestJS project. Integrate Moralis/Alchemy to pull raw wallet data. [cite_start]Build the math logic to calculate basic PnL[cite: 40].
* **Week 2 (AI Integration):** Build the AI summary service. [cite_start]Feed the calculated data to Claude/GPT to generate the strategy and token preference summaries[cite: 40].
* **Week 3 (API Finalization):** Finalize the `GET /report` endpoint, ensuring fast response times. [cite_start]Implement the 3-lookups/day rate limiting[cite: 38, 40].
* **Week 4 (Testing & Launch Prep):** End-to-end testing with the Next.js frontend. [cite_start]Prepare for Crypto Twitter and Product Hunt launch[cite: 40].

## 6. Future Roadmap (Post-MVP)
*Do not build these during the 4-week MVP sprint. Keep architecture flexible to support them later.*
* [cite_start]**Layer 2 (Pattern Intelligence):** Bot/whale detection, clustering similar wallets ("Find me 50 wallets like this one"), and predictive buying patterns[cite: 24, 25, 26, 27].
* [cite_start]**Layer 3 (Alerts & Monitoring):** Webhooks/cron jobs for push notifications ("Whale X just bought Y token") and copy-trading tools[cite: 28, 29, 30, 31].