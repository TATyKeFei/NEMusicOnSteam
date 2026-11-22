"""Run Python tests with source paths resolved from the repository root."""

from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


def main():
    suite = unittest.TestSuite()
    for tests, source in (
        ("tests/backend", "backend"),
        ("tests/diagnostics", "tools/diagnostics"),
    ):
        sys.path.insert(0, str(ROOT / source))
        suite.addTests(unittest.TestLoader().discover(str(ROOT / tests), pattern="test_*.py"))
    result = unittest.TextTestRunner().run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
