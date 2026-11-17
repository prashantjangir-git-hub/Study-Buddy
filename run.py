"""Start Study Buddy and open it in your browser.   python run.py"""
import threading
import webbrowser

import uvicorn

from app import config

if __name__ == "__main__":
    url = f"http://{config.HOST}:{config.PORT}"
    print(f"\n  Study Buddy is running at {url}\n  Press Ctrl+C to stop.\n")
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="warning")
