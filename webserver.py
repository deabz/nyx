from threading import Thread
import os

from flask import Flask, jsonify, render_template_string

app = Flask(__name__)

PAGE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ab | Status</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           background: radial-gradient(circle at top, #25204a, #0d0d16 65%); color: #f7f4ff; }
    main { width: min(560px, calc(100% - 40px)); padding: 42px; border: 1px solid #40376b;
           border-radius: 24px; background: rgba(20, 18, 36, .88); box-shadow: 0 24px 80px #0008; }
    .brand { color: #b9a6ff; letter-spacing: .2em; text-transform: uppercase; font-size: .8rem; }
    h1 { font-size: clamp(2.6rem, 10vw, 5rem); margin: 12px 0; }
    .status { display: inline-flex; align-items: center; gap: 10px; padding: 10px 14px;
              border-radius: 999px; background: #123c2a; color: #83f0b4; font-weight: 700; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #48e58e; box-shadow: 0 0 16px #48e58e; }
    p { color: #bbb5ce; line-height: 1.6; }
    footer { margin-top: 30px; color: #77718d; font-size: .85rem; }
  </style>
</head>
<body>
  <main>
    <div class="brand">ab monitoring</div>
    <h1>Bot online</h1>
    <div class="status"><span class="dot"></span> Operational</div>
    <p>ab is connected and responding to Discord events. This page is the bot's public health check.</p>
    <footer>Health endpoint: <a href="/health">/health</a></footer>
  </main>
</body>
</html>
"""


@app.route("/")
def home():
    return render_template_string(PAGE)


@app.route("/health")
def health():
    return jsonify({"bot": "ab", "status": "online"})


def run():
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))


def keep_alive():
    Thread(target=run, daemon=True).start()