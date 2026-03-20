import { Injectable } from '@nestjs/common';

@Injectable()
export class WalletClassifierService {
  classifyWallet(metrics: any, tokenPnl: any[]) {
    const { total_transactions, unique_tokens } = metrics;

    let walletType = 'unknown';
    let riskLevel = 'medium';

    // 🧠 Behavior rules
    if (unique_tokens > 20) {
      walletType = 'degen';
      riskLevel = 'high';
    }

    if (total_transactions < 20) {
      walletType = 'retail';
    }

    // Check if mostly losses
    const losses = tokenPnl.filter((t) => t.pnl < 0).length;

    if (losses > tokenPnl.length / 2) {
      riskLevel = 'high';
    }

    // Summary (basic AI-like output)
    let summary = '';

    if (walletType === 'degen') {
      summary = 'This wallet frequently trades many tokens, likely chasing hype or memecoins.';
    } else if (walletType === 'retail') {
      summary = 'This wallet shows low activity and limited trading experience.';
    } else {
      summary = 'This wallet has moderate trading behavior.';
    }

    return {
      wallet_type: walletType,
      risk_level: riskLevel,
      summary,
    };
  }
}