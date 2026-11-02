export type GameLaunchMode = "cookie" | "credentials";

export type GameLaunchTicket = {
  ticket: string;
  expiresAt: number;
  gameUrl: string;
};

export function hasGameLaunchExtension(): boolean {
  return document.documentElement.dataset.reelaxGameLaunchExtension === "1";
}

export function launchWithExtension(ticket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("reelax:game-launch-result", onResult);
      reject(new Error("扩展没有响应，请刷新页面后再试"));
    }, 12_000);

    const onResult = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("reelax:game-launch-result", onResult);
      if (detail.ok) resolve();
      else reject(new Error(String(detail.error || "扩展登录失败")));
    };

    window.addEventListener("reelax:game-launch-result", onResult);
    window.dispatchEvent(
      new CustomEvent("reelax:game-launch", { detail: { requestId, ticket } }),
    );
  });
}

export function gameLaunchUrl(gameUrl: string, ticket: string): string {
  return `${gameUrl.replace(/\/+$/, "")}/#reelax_login=${encodeURIComponent(ticket)}`;
}

export function buildGameBookmarklet(serverOrigin: string): string {
  const origin = JSON.stringify(serverOrigin.replace(/\/+$/, ""));
  const code = [
    "javascript:(async()=>{",
    "const m=location.hash.match(/reelax_login=([^&]+)/);",
    "if(!m){alert('请先从 Reelax 账号卡片点击「打开游戏」');return}",
    `const r=await fetch(${origin}+'/api/game-launch/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:decodeURIComponent(m[1])})});`,
    "const d=await r.json().catch(()=>({}));",
    "if(!r.ok)throw new Error(d?.error?.message||('HTTP '+r.status));",
    "if(!d.email||!d.password)throw new Error('该账号没有可自动填写的密码，请使用扩展登录');",
    "history.replaceState(null,'',location.pathname+location.search);",
    "const set=(el,v)=>{if(!el)return;const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};",
    "const email=document.querySelector('input[type=email],input[name=email],input[autocomplete=username],input[autocomplete=email]');",
    "const password=document.querySelector('input[type=password],input[name=password],input[autocomplete=current-password]');",
    "set(email,d.email);set(password,d.password);",
    "if(password)password.focus();",
    "alert('账号和密码已自动填写，请确认后登录');",
    "})().catch(e=>alert('自动填写失败：'+(e?.message||String(e))))",
  ].join("");
  return code;
}