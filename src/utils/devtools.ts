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
  // ── Element data collector ────────────────────────────────────────────────
  var EL_STYLES=['display','position','top','right','bottom','left','width','height','margin','padding','box-sizing','border','border-radius','flex','flex-direction','justify-content','align-items','gap','grid-template-columns','font-size','font-weight','line-height','color','background-color','text-align','z-index','overflow','opacity','transform'];
  var PARENT_STYLES=['display','flex-direction','flex-wrap','justify-content','align-items','align-content','gap','grid-template-columns','grid-template-rows','grid-auto-flow','padding','position','width','height'];
  function btSummary(n){
    if(!n||!n.tagName){return '';}
    var t=n.tagName.toLowerCase();
    var id=n.id?'#'+n.id:'';
    var c=(n.classList&&n.classList.length)?'.'+Array.prototype.slice.call(n.classList,0,3).join('.'):'';
    var tx=(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40);
    return '<'+t+id+c+'>'+(tx?' "'+tx+'"':'');
  }
  function btPath(node){
    if(node.id){return '#'+node.id;}
    var parts=[];var cur=node;
    while(cur&&cur.nodeType===1&&cur!==document.body&&parts.length<6){
      var s=cur.tagName.toLowerCase();
      if(cur.id){parts.unshift('#'+cur.id);break;}
      if(cur.classList&&cur.classList.length){s+='.'+Array.prototype.slice.call(cur.classList,0,2).join('.');}
      var p=cur.parentElement;
      if(p){var same=Array.prototype.filter.call(p.children,function(x){return x.tagName===cur.tagName;});if(same.length>1){s+=':nth-of-type('+(Array.prototype.indexOf.call(same,cur)+1)+')';}}
      parts.unshift(s);cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function btStyles(node,list){
    var cs=getComputedStyle(node);var o={};
    for(var i=0;i<list.length;i++){var v=cs.getPropertyValue(list[i]);if(v){o[list[i]]=v;}}
    return o;
  }
  function btCollect(el){
    var r=el.getBoundingClientRect();
    var attrs={};
    for(var i=0;i<el.attributes.length;i++){attrs[el.attributes[i].name]=el.attributes[i].value;}
    return {
      type:'__bt_inspect_element',
      tag:el.tagName.toLowerCase(),
      id:el.id||'',
      classes:Array.prototype.slice.call(el.classList),
      selector:btPath(el),
      pageUrl:location.href,
      rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
      text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,300),
      attributes:attrs,
      outerHTML:(el.outerHTML||'').slice(0,1500),
      parentSummary:btSummary(el.parentElement),
      prevSibling:btSummary(el.previousElementSibling),
      nextSibling:btSummary(el.nextElementSibling),
      computed:btStyles(el,EL_STYLES),
      parentComputed:el.parentElement?btStyles(el.parentElement,PARENT_STYLES):{},
      viewport:{width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio}
    };
  }
  // Inspect mode — controlled by postMessage from parent
  var hl=null;
  function move(e){
    var el=document.elementFromPoint(e.clientX,e.clientY);
    if(!el||el===hl){return;}
    var r=el.getBoundingClientRect();
    hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';
  }
  function click(e){
    e.preventDefault();e.stopPropagation();
    var el=document.elementFromPoint(e.clientX,e.clientY);
    if(!el||el===hl){return;}
    try{parent.postMessage(btCollect(el),'*');}
    catch(err){parent.postMessage({type:'__bt_inspect_element',tag:el.tagName.toLowerCase(),id:el.id||'',classes:Array.prototype.slice.call(el.classList)},'*');}
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
