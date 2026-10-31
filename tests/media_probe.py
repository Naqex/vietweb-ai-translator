"""Probe CLIProxyAPI multimodal support: image OCR+translate with boxes, and audio input."""
import base64, io, json, os, struct, sys, time, urllib.request, wave, math
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {}
for line in open(os.path.join(ROOT, '.env.local'), encoding='utf-8'):
    if '=' in line:
        k, v = line.strip().split('=', 1)
        env[k] = v
KEY, EP = env['VIWEB_KEY'], env['VIWEB_ENDPOINT'].rstrip('/')
MODELS = sys.argv[1:] or ['gemini-3-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash-high']


def make_image():
    img = Image.new('RGB', (800, 450), (245, 240, 230))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 44)
    s = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 28)
    d.rectangle([60, 50, 520, 130], outline=(0, 0, 0), width=3)
    d.text((80, 62), '今天天气真好', font=f, fill=(0, 0, 0))
    d.rectangle([300, 250, 740, 330], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
    d.text((320, 265), '我们去公园吧！', font=f, fill=(200, 0, 0))
    d.text((60, 380), 'Giá: 3000 yuan - SALE 50%', font=s, fill=(0, 0, 120))
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


def call(model, content, max_tokens=600):
    body = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': content}],
                       'max_tokens': max_tokens, 'temperature': 0}).encode()
    req = urllib.request.Request(EP + '/chat/completions', body,
                                 {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            j = json.load(r)
        return round(time.time() - t, 2), j['choices'][0]['message']['content'], j.get('usage')
    except urllib.error.HTTPError as e:
        return round(time.time() - t, 2), 'HTTP %s %s' % (e.code, e.read()[:300].decode('utf-8', 'replace')), None
    except Exception as e:
        return round(time.time() - t, 2), 'ERR %s' % e, None


PROMPT = ('Detect every text region in the image. Return ONLY JSON array of objects '
          '{"box_2d":[ymin,xmin,ymax,xmax] (0-1000), "src":"original text", "vi":"Vietnamese translation"}.')

png = make_image()
open(os.path.join(ROOT, 'tests', '_probe.png'), 'wb').write(png)
data_url = 'data:image/png;base64,' + base64.b64encode(png).decode()
print('== IMAGE OCR + boxes + translate ==')
for m in MODELS:
    dt, out, usage = call(m, [{'type': 'text', 'text': PROMPT}, {'type': 'image_url', 'image_url': {'url': data_url}}])
    print(f'--- {m}: {dt}s usage={usage}')
    print(out[:700])

print('\n== AUDIO input (tone + no speech; checks whether the proxy accepts audio parts) ==')
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
wav = base64.b64encode(buf.getvalue()).decode()
for m in MODELS[:2]:
    dt, out, usage = call(m, [{'type': 'text', 'text': 'Describe this audio in one sentence.'},
                              {'type': 'input_audio', 'input_audio': {'data': wav, 'format': 'wav'}}], 200)
    print(f'--- {m}: {dt}s usage={usage}\n{out[:300]}')
