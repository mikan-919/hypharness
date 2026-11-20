"""基準の学習スクリプト。研究エージェントはこのファイルを書き換えて val bpb を下げる。

バイト単位の小さな GPT を、prepare.batches が返す分（prepare.TOKEN_BUDGET バイト）だけ学習し、最後に prepare.report を呼ぶ。
"""

import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import prepare

SEED = int(os.environ.get("HYPH_SEED", "0"))
DIM, LAYERS, HEADS = 512, 8, 8
BATCH = 32
LR, WARMUP = 1e-3, 200

torch.manual_seed(SEED)
np.random.seed(SEED)
torch.backends.cuda.matmul.allow_tf32 = True


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.ln1, self.ln2 = nn.LayerNorm(DIM), nn.LayerNorm(DIM)
        self.qkv, self.proj = nn.Linear(DIM, 3 * DIM), nn.Linear(DIM, DIM)
        self.mlp = nn.Sequential(nn.Linear(DIM, 4 * DIM), nn.GELU(), nn.Linear(4 * DIM, DIM))

    def forward(self, x):
        B, T, _ = x.shape
        q, k, v = self.qkv(self.ln1(x)).view(B, T, 3, HEADS, DIM // HEADS).transpose(1, 3).unbind(2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.proj(y.transpose(1, 2).reshape(B, T, DIM))
        return x + self.mlp(self.ln2(x))


class GPT(nn.Module):
    def __init__(self):
        super().__init__()
        self.tok = nn.Embedding(prepare.VOCAB, DIM)
        self.pos = nn.Embedding(prepare.SEQ_LEN, DIM)
        self.blocks = nn.ModuleList(Block() for _ in range(LAYERS))
        self.ln = nn.LayerNorm(DIM)
        self.head = nn.Linear(DIM, prepare.VOCAB, bias=False)

    def forward(self, idx):
        x = self.tok(idx) + self.pos(torch.arange(idx.shape[1], device=idx.device))
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln(x))


def main():
    model = GPT().cuda()
    opt = torch.optim.AdamW(model.parameters(), lr=LR, betas=(0.9, 0.95), weight_decay=0.1, fused=True)
    steps = prepare.TOKEN_BUDGET // (BATCH * prepare.SEQ_LEN)
    start = time.time()
    for step, (x, y) in enumerate(prepare.batches(BATCH)):
        # 学習率は線形に上げたあと、予算の終わりに向けて線形に下げる
        lr = LR * min((step + 1) / WARMUP, 1 - step / steps)
        for g in opt.param_groups:
            g["lr"] = lr
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = F.cross_entropy(model(x).float().view(-1, prepare.VOCAB), y.reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 100 == 0:
            print(f"step {step}/{steps} loss {loss.item():.4f} lr {lr:.2e} {time.time() - start:.0f}s", flush=True)
    with torch.autocast("cuda", dtype=torch.bfloat16):
        prepare.report(model)


if __name__ == "__main__":
    main()
