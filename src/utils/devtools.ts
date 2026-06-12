// ── DevTools script injected into every proxied HTML page ─────────────────────
// Uses parent.postMessage to relay data to browser.js in the webview.
const DEVTOOLS_SCRIPT = `(function(){
  if(window.__btInjected){return;}window.__btInjected=true;
  // Console Mirror
  ['log','info','warn','error','debug'].forEach(function(lvl){
    var o=console[lvl].bind(console);
    console[lvl]=function(){
      o.apply(console,arguments);
      try{
        var args=Array.prototype.slice.call(arguments).map(function(a){
          try{return typeof a==='object'?JSON.stringify(a,null,0):String(a);}catch(e){return String(a);}
        });
        parent.postMessage({type:'__bt_console',level:lvl,args:args},'*');
      }catch(e){}
    };
  });
  // Network — fetch
  var _fetch=window.fetch;
  if(_fetch){
    window.fetch=function(input,init){
      var u=typeof input==='string'?input:(input&&input.url)||String(input);
      var m=((init&&init.method)||'GET').toUpperCase();
      var id=Date.now()+'_'+Math.random();
      parent.postMessage({type:'__bt_network_request',reqId:id,method:m,url:u},'*');
      return _fetch.apply(this,arguments).then(function(r){
        parent.postMessage({type:'__bt_network_response',reqId:id,status:r.status,statusText:r.statusText,url:u},'*');
        return r;
      })['catch'](function(e){
        parent.postMessage({type:'__bt_network_response',reqId:id,status:0,statusText:'Network error',url:u},'*');
        throw e;
      });
    };
  }
  // Network — XHR
  var _XHR=window.XMLHttpRequest;
  if(_XHR){
    window.XMLHttpRequest=function(){
      var x=new _XHR();var info={m:'GET',u:''};var id=Date.now()+'_'+Math.random();
      var _open=x.open.bind(x);
      x.open=function(m,u){info.m=(m||'GET').toUpperCase();info.u=u||'';return _open.apply(x,arguments);};
      x.addEventListener('loadstart',function(){parent.postMessage({type:'__bt_network_request',reqId:id,method:info.m,url:info.u},'*');});
      x.addEventListener('loadend',function(){parent.postMessage({type:'__bt_network_response',reqId:id,status:x.status,statusText:x.statusText,url:info.u},'*');});
      return x;
    };
    window.XMLHttpRequest.prototype=_XHR.prototype;
  }
  // Inspect mode — controlled by postMessage from parent
  var hl=null;
  function move(e){
    var el=document.elementFromPoint(e.clientX,e.clientY);
    if(!el||el===hl){return;}
    var r=el.getBoundingClientRect();
    hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';
  }
  function clsList(node){
    var c=node.className;
    if(typeof c!=='string'){ c=(node.classList?Array.prototype.join.call(node.classList,' '):''); }
    return c.trim()?c.trim().split(/\\s+/):[];
  }
  function cssSel(node){
    if(!node||node.nodeType!==1){return '';}
    var parts=[];var cur=node;var depth=0;
    while(cur&&cur.nodeType===1&&depth<5){
      if(cur.id){parts.unshift('#'+cur.id);break;}
      var sel=cur.tagName.toLowerCase();
      var cls=clsList(cur).slice(0,3);
      if(cls.length){sel+='.'+cls.join('.');}
      var par=cur.parentNode;
      if(par&&par.children){
        var same=Array.prototype.filter.call(par.children,function(c){return c.tagName===cur.tagName;});
        if(same.length>1){sel+=':nth-of-type('+(Array.prototype.indexOf.call(same,cur)+1)+')';}
      }
      parts.unshift(sel);cur=par;depth++;
    }
    return parts.join(' > ');
  }
  function attrMap(node){
    var o={};if(!node.attributes){return o;}
    for(var i=0;i<node.attributes.length;i++){var a=node.attributes[i];o[a.name]=a.value;}
    return o;
  }
  function summarize(node){
    if(!node||node.nodeType!==1){return '';}
    var s=node.tagName.toLowerCase();
    if(node.id){s+='#'+node.id;}
    var cls=clsList(node);
    if(cls.length){s+='.'+cls.join('.');}
    return s;
  }
  function click(e){
    e.preventDefault();e.stopPropagation();
    var el=document.elementFromPoint(e.clientX,e.clientY);
    if(!el||el===hl){return;}
    var r=el.getBoundingClientRect();
    var oh=el.outerHTML||'';
    if(oh.length>4000){oh=oh.slice(0,4000)+' <!-- truncated -->';}
    var txt=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
    if(txt.length>500){txt=txt.slice(0,500)+'…';}
    parent.postMessage({
      type:'__bt_inspect_element',
      tag:el.tagName.toLowerCase(),
      id:el.id||'',
      classes:clsList(el),
      attributes:attrMap(el),
      selector:cssSel(el),
      outerHTML:oh,
      text:txt,
      rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
      parentSummary:summarize(el.parentElement),
      pageUrl:location.href
    },'*');
  }
  window.addEventListener('message',function(ev){
    var msg=ev.data;if(!msg||!msg.type){return;}
    if(msg.type==='__bt_enable_inspect'){
      if(hl){return;}
      hl=document.createElement('div');hl.id='__bt_hl';
      hl.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #f0b429;background:rgba(240,180,41,0.08);border-radius:2px;transition:all 0.08s;';
      document.body.appendChild(hl);
      document.addEventListener('mousemove',move);document.addEventListener('click',click,true);
      document.body.style.cursor='crosshair';
    }
    if(msg.type==='__bt_disable_inspect'){
      document.removeEventListener('mousemove',move);document.removeEventListener('click',click,true);
      if(hl){hl.remove();hl=null;}document.body.style.cursor='';
    }
  });
})();`;

export const INJECT_TAG = `<script data-bt-devtools="1">${DEVTOOLS_SCRIPT}</script>`;