import json, http.server, socketserver, os, sys
DICT = {
 "How Life Insurance Evolved in Japan": "日本寿险是如何演变的",
 "By Research Desk · 6 min read": "研究部 · 阅读约 6 分钟",
 "After the war, Japanese insurers rebuilt their business around a vast network of door-to-door sales agents.": "战后，日本保险公司围绕庞大的上门销售代理人网络重建了业务。",
 "These agents visited households regularly, which helped the industry reach almost every family in the country.": "这些代理人定期拜访家庭，使行业几乎覆盖了全国每一个家庭。",
 "The agent model": "代理人模式",
 "Read the full report": "阅读完整报告",
 "Most agents worked part-time and were paid largely by commission.": "大多数代理人是兼职，收入主要来自佣金。",
 "Trust, not price, was the main reason customers stayed with the same insurer for decades.": "让客户数十年不换保险公司的主要原因是信任，而不是价格。",
 "As the population aged, insurers shifted from death protection toward savings and medical products.": "随着人口老龄化，保险公司从身故保障转向储蓄和医疗产品。",
 "This paragraph was loaded later by the page.": "这一段是页面稍后加载的。",
 "Home": "首页", "Markets": "市场", "Research": "研究", "About": "关于",
 "so today we're going to talk about how compound interest works": "今天我们来聊聊复利是怎么运作的",
 "it is the most powerful force in personal finance.": "它是个人理财中最强大的力量。",
 "Let's start with a simple example": "我们从一个简单的例子开始",
}
LOG = []
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a, directory=os.path.join(os.path.dirname(__file__),'fixtures'), **k)
    def log_message(self,*a): pass
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); super().end_headers()
    def do_OPTIONS(self): self.send_response(204); self.end_headers()
    def do_GET(self):
        if self.path == '/log':
            b=json.dumps(LOG).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b); return
        return super().do_GET()
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0)); body=json.loads(self.rfile.read(n))
        user=body['messages'][-1]['content']
        try: arr=json.loads(user); assert isinstance(arr,list)
        except Exception: arr=None
        LOG.append({'auth':self.headers.get('Authorization'),'model':body.get('model'),'n':len(arr) if arr else 1,'items':arr})
        tr=lambda s: DICT.get(s, '【译】'+s)
        content = json.dumps({'t':[tr(x) for x in arr]}, ensure_ascii=False) if arr is not None else tr(user)
        out=json.dumps({'choices':[{'message':{'role':'assistant','content':'```json\n'+content+'\n```'}}]}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(out)
socketserver.TCPServer.allow_reuse_address=True
with socketserver.ThreadingTCPServer(('127.0.0.1',8787),H) as s: s.serve_forever()
