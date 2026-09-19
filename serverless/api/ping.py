"""GET /api/ping: see lib/cboe.py (dispatch) for the parameters and the JSON returned."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import cboe  # noqa: E402


class handler(cboe.BaseHandler):
    op = "ping"
