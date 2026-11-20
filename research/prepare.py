"""研究の固定部。データ、学習の予算、評価を決める。エージェントはこのファイルを変更できない。

トークナイザーを持たず、UTF-8 のバイト列をそのまま学習する（語彙は256）。
指標の val bpb は、検証データ1バイトあたりの交差エントロピーをビットで表したもの。

    python prepare.py <出力先>   # FineWeb-edu の1シャードから train.bin と val.bin を作る（ネットワークが要る）
"""

import math
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F

DATA = os.environ.get("HYPH_DATA", "/data")
# 学習に使えるバイト数。GPU を Windows の画面と分け合うため、時間ではなく量で予算を決める。
# 他の処理と GPU を取り合っても、結果は変わらず時間だけが延びる
TOKEN_BUDGET = 32 * 2**20
SEQ_LEN = 1024  # 評価の文脈長。モデルはこの長さの入力を受け付けること
VOCAB = 256
EVAL_BYTES = 8 * 2**20

SHARD = "https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu/resolve/main/sample/10BT/000_00000.parquet"
TRAIN_BYTES = 2 * 2**30
VAL_BYTES = 64 * 2**20


def batches(batch_size, seq_len=SEQ_LEN, device="cuda"):
    """学習データから無作為な位置の (入力, 次のバイト) を、合計 TOKEN_BUDGET バイトに達するまで返す"""
    data = np.memmap(f"{DATA}/train.bin", dtype=np.uint8, mode="r")
    for _ in range(TOKEN_BUDGET // (batch_size * seq_len)):
        ix = np.random.randint(0, len(data) - seq_len - 1, batch_size)
        x = torch.from_numpy(np.stack([data[i : i + seq_len + 1] for i in ix]).astype(np.int64))
        x = x.pin_memory().to(device, non_blocking=True)
        yield x[:, :-1], x[:, 1:]


@torch.no_grad()
def evaluate(model, device="cuda", batch_size=8):
    """model(x) は (B, SEQ_LEN) のバイト列から (B, SEQ_LEN, 256) のロジットを返すこと。検証データの先頭の固定範囲で bpb を返す"""
    data = np.memmap(f"{DATA}/val.bin", dtype=np.uint8, mode="r")[: EVAL_BYTES + 1]
    n = (len(data) - 1) // SEQ_LEN
    model.eval()
    total, count = 0.0, 0
    for s in range(0, n, batch_size):
        rows = [data[i * SEQ_LEN : (i + 1) * SEQ_LEN + 1] for i in range(s, min(s + batch_size, n))]
        x = torch.from_numpy(np.stack(rows).astype(np.int64)).to(device)
        logits = model(x[:, :-1])
        total += F.cross_entropy(logits.float().reshape(-1, VOCAB), x[:, 1:].reshape(-1), reduction="sum").item()
        count += x[:, 1:].numel()
    return total / count / math.log(2)


def report(model):
    """学習の最後に呼ぶ。ハーネスはこの行を結果として読む"""
    print(f"val_bpb: {evaluate(model):.6f}", flush=True)


def download(out):
    """文書の区切りに 0 のバイトを置いてつなぎ、先頭を検証用、続きを学習用にする"""
    import urllib.request

    import pyarrow.parquet as pq

    os.makedirs(out, exist_ok=True)
    shard = f"{out}/shard.parquet"
    if not os.path.exists(shard):
        urllib.request.urlretrieve(SHARD, shard + ".part")
        os.rename(shard + ".part", shard)
    val, train = open(f"{out}/val.bin.part", "wb"), open(f"{out}/train.bin.part", "wb")
    written = [0, 0]
    for batch in pq.ParquetFile(shard).iter_batches(columns=["text"], batch_size=1024):
        for text in batch.column(0).to_pylist():
            b = text.encode() + b"\0"
            i = 0 if written[0] < VAL_BYTES else 1
            (val, train)[i].write(b)
            written[i] += len(b)
        if written[1] >= TRAIN_BYTES:
            break
    val.close()
    train.close()
    os.rename(f"{out}/val.bin.part", f"{out}/val.bin")
    os.rename(f"{out}/train.bin.part", f"{out}/train.bin")
    os.remove(shard)
    print(f"val {written[0]} バイト、train {written[1]} バイト")


if __name__ == "__main__":
    download(sys.argv[1])
