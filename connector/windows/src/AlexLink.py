"""Entry point for PyInstaller and for running from source: pythonw src\\AlexLink.py"""
import sys

from alexconn.app import main

if __name__ == "__main__":
    sys.exit(main())
