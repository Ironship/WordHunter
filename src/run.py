import sys
from pathlib import Path

# Add the directory containing wordhunter to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from wordhunter.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
