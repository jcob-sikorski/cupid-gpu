from bark import SAMPLE_RATE, generate_audio, preload_models
from werkzeug.middleware.proxy_fix import ProxyFix
from scipy.io.wavfile import write as write_wav
from flask import Flask, request, send_file, make_response
from pathlib import Path
import numpy as np
import datetime
import shutil
import math
import time

static_dir = Path("./static")

if static_dir.exists():
    shutil.rmtree(static_dir.absolute())

static_dir.mkdir(parents=True, exist_ok=True)

print("Loading Bark TTS models...")
preload_models()

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

def date_now():
    now = datetime.datetime.now()
    millis = datetime.datetime.timestamp(now) * 1000
    return math.floor(millis)

@app.route("/")
def hello():
    return "Hello, World!"

@app.post("/generate")
def generate():
    body = request.get_json()

    st = time.time()
    pieces = [generate_audio(body['prompt'], history_prompt=body['preset'])]

    et = time.time()
    seconds = et-st

    output_path = static_dir.joinpath("tts_" + str(date_now()) + ".wav").absolute()
    write_wav(output_path, SAMPLE_RATE, np.concatenate(pieces))

    response = make_response(send_file(output_path, mimetype="audio/wav"))
    response.headers["x-elapsed-sec"] = str(seconds)
    return response

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=8123, debug=False)
