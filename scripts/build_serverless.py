"""Copy the canonical any-ticker module into the serverless project (run after editing src/pricer/cboe.py).

    python scripts/build_serverless.py
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
shutil.copyfile(ROOT / "src/pricer/cboe.py", ROOT / "serverless/lib/cboe.py")
print("serverless/lib/cboe.py refreshed from src/pricer/cboe.py")
