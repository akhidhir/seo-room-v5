(function(){
  function norm(s){
    var r = (s||'').replace(/<[^>]+>/g,'');
    r = r.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ').replace(/&mdash;/g,'-').replace(/&ndash;/g,'-').replace(/&rsquo;/g,"'").replace(/&lsquo;/g,"'").replace(/&rdquo;/g,'"').replace(/&ldquo;/g,'"');
    var out = '';
    for(var i=0;i<r.length;i++){
      var c = r.charCodeAt(i);
      if(c===8216||c===8217||c===8218||c===8219) out += "'";
      else if(c===8220||c===8221||c===8222||c===8223) out += '"';
      else if(c===8211||c===8212) out += '-';
      else out += r[i];
    }
    return out.replace(/\s+/g,' ').trim().toLowerCase();
  }

  // Apply highlight inline styles — subtle orange accent, preserves original colors
  function applyHL(el){
    el.style.setProperty('border-left','3px solid #f59e0b','important');
    el.style.setProperty('padding-left','10px','important');
    el.style.setProperty('background','rgba(245,158,11,0.10)','important');
    el.style.setProperty('border-radius','3px','important');
    el.setAttribute('data-seo-hl','1');
  }

  // ── Per-site branding helpers ───────────────────────────────────────────────
  function parseRgb(s){ var m=(s||'').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?/); return m?[+m[1],+m[2],+m[3], m[4]===undefined?1:+m[4]]:null; }
  function isVivid(rgb){ if(!rgb || rgb[3] < 0.4) return false; var r=rgb[0],g=rgb[1],b=rgb[2]; var mx=Math.max(r,g,b), mn=Math.min(r,g,b); if(mx<70) return false; /*near-black/text*/ if(mn>225) return false; /*near-white*/ if(mx-mn<28) return false; /*grey*/ return true; }
  // Detect the site's primary brand/accent colour (accordion icon → button → link)
  function getSiteAccent(){
    // Tally vivid colours by frequency + weight; the dominant brand colour wins (a single gold CTA can't hijack it).
    var counts={};
    function add(c, w){ var rgb=parseRgb(c); if(!isVivid(rgb)) return; var key='rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')'; counts[key]=(counts[key]||0)+(w||1); }
    function scan(sel, prop, max, w){ var els=document.querySelectorAll(sel), n=0; for(var i=0;i<els.length;i++){ var e=els[i]; if(e.closest('.seo-preview-bar,.seo-new-block,footer,.elementor-location-footer')) continue; try{ add(window.getComputedStyle(e)[prop], w); }catch(x){} if(++n>=max) break; } }
    scan('.acc-toggle .down,.acc-toggle .up,.elementor-accordion-icon,[class*="accordion"] [class*="icon"]','backgroundColor',6,4); // FAQ icon = strongest signal
    scan('h1,h2,h3','color',16,3);   // headings carry brand colour
    scan('a','color',50,1);          // links
    scan('.elementor-button,a.button,button,.btn,[class*="cta"]','backgroundColor',14,1); // CTAs (often a contrasting secondary colour) weighted low
    var best=null, bestN=0; for(var k in counts){ if(counts[k]>bestN){ bestN=counts[k]; best=k; } }
    return best || '#1f4fe0';
  }
  // Read the site's real accordion so the preview FAQ can mirror it exactly
  function readSiteAccordion(){
    var out={};
    function info(el){ if(!el) return null; try{ var c=window.getComputedStyle(el); return {color:c.color,bg:c.backgroundColor,font:c.fontFamily,weight:c.fontWeight,size:c.fontSize,radius:c.borderRadius,pad:c.padding,w:c.width,h:c.height,shadow:c.boxShadow}; }catch(e){ return null; } }
    var title = document.querySelector('.acc-toggle, .elementor-tab-title, .elementor-toggle-title, [class*="accordion"] [class*="title"], [class*="accordion"] [class*="header"]');
    var icon  = document.querySelector('.acc-toggle .down,.acc-toggle .up, .elementor-accordion-icon, [class*="accordion"] [class*="icon"]');
    var item  = title ? (title.closest('.acc-item,.elementor-accordion-item,.elementor-toggle-item') || title.parentElement) : null;
    var content = document.querySelector('.acc-content, .elementor-tab-content, [class*="accordion"] [class*="content"]');
    out.title=info(title); out.icon=info(icon); out.item=info(item); out.content=info(content);
    return out;
  }
  // Restyle preview FAQ accordions (<details>/<summary>) to MIRROR this specific site's accordion design.
  function styleFaqToMatchSite(accent){
    if(!document.querySelector('.seo-new-block details')) return;
    var a = readSiteAccordion();
    var t=a.title||{}, ic=a.icon||{}, it=a.item||{}, ct=a.content||{};
    var qColor = t.color || '#1a1b1e';
    var qFont  = t.font  || '';
    var qWeight= t.weight|| '500';
    var qSize  = t.size  || '16px';
    var pillBg = (it.bg && parseRgb(it.bg) && parseRgb(it.bg)[3]>0.1) ? it.bg : '#ffffff';
    var pillRadius = (t.radius && t.radius!=='0px') ? t.radius : (it.radius && it.radius!=='0px' ? it.radius : '14px');
    // Icon circle: prefer the site's accordion icon background, else the detected brand accent
    var circleBg = (ic.bg && isVivid(parseRgb(ic.bg))) ? ic.bg : accent;
    var circleColor = ic.color || '#ffffff';
    var circle = (ic.radius==='50%' || (ic.w && ic.w===ic.h)) ; // looks like a circle on the site
    var aColor = ct.color || '#5b6470';
    var aFont  = ct.font  || qFont;
    var aSize  = ct.size  || '15px';
    var arrowMode = circle; // circle-with-arrow vs plain chevron
    var css = ''
      + '.seo-new-block details{background:'+pillBg+';border:none;border-radius:'+pillRadius+';margin-bottom:12px;overflow:hidden;box-shadow:0 5px 16px rgba(2,6,23,.06)}'
      + '.seo-new-block details summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 14px 14px 22px;min-height:54px;box-sizing:border-box;'
          + 'color:'+qColor+';' + (qFont?'font-family:'+qFont+';':'') + 'font-weight:'+qWeight+';font-size:'+qSize+';line-height:1.4}'
      + '.seo-new-block details summary::-webkit-details-marker{display:none}'
      + '.seo-new-block details summary::before{display:none !important}';
    if(arrowMode){
      css += '.seo-new-block details summary::after{content:"\\2193";flex:0 0 auto;width:30px;height:30px;border-radius:50%;background:'+circleBg+';color:'+circleColor+';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;line-height:1;transition:transform .2s}'
           + '.seo-new-block details[open] summary::after{content:"\\2191"}';
    } else {
      css += '.seo-new-block details summary::after{content:"";flex:0 0 auto;width:10px;height:10px;border-right:2px solid '+circleBg+';border-bottom:2px solid '+circleBg+';transform:rotate(45deg);transition:transform .2s}'
           + '.seo-new-block details[open] summary::after{transform:rotate(-135deg)}';
    }
    css += '.seo-new-block details>*:not(summary){padding:2px 22px 18px 22px;color:'+aColor+';' + (aFont?'font-family:'+aFont+';':'') + 'font-size:'+aSize+'}';
    var prev=document.getElementById('seo-faq-match'); if(prev) prev.remove();
    var st=document.createElement('style'); st.id='seo-faq-match'; st.textContent=css; document.head.appendChild(st);
    console.log('[SEO Room] FAQ matched to site — question '+qColor+', circle '+circleBg+', font '+(qFont||'inherit'));
  }

  function run(){
    var dataEl = document.getElementById('seo-section-data');
    if(!dataEl){ console.log('[SEO Room] No section data found'); return; }
    var sections = JSON.parse(dataEl.textContent);
    var matched = 0;
    var totalReplacements = 0;
    var total = sections.filter(function(s){return !s.is_new;}).length;

    // Detect this site's brand accent colour and expose it to all preview CSS as --seo-accent
    var siteAccent = '#1f4fe0';
    try { siteAccent = getSiteAccent(); document.documentElement.style.setProperty('--seo-accent', siteAccent); } catch(e){}
    console.log('[SEO Room] Site accent detected: ' + siteAccent);

    console.log('[SEO Room] Starting DIRECT paragraph matching for '+sections.length+' sections');

    var skipSelector = 'form,footer,nav,header,.seo-preview-bar,.widget,.sidebar,.elementor-widget-form,.elementor-form,.wpcf7,.wpforms-container,.gform_wrapper,.site-footer,.footer-widget,.elementor-location-footer,.elementor-widget-itestimonials,.elementor-widget-call-to-action,.elementor-widget-ibutton,.elementor-widget-image,.elementor-widget-iteams,.elementor-widget-ipricingtable,.elementor-widget-price-table,.elementor-widget-iservice_box2,.elementor-widget-icon-box,.elementor-widget-image-carousel,.elementor-widget-shortcode';
    var replacedEls = new Set();

    sections.forEach(function(section){
      if(section.is_new) return;
      if(!section.draft_text || !section.original_text) return;

      // Parse original into paragraphs — original_text is PLAIN TEXT with \n\n breaks
      var origParas = [];
      (section.original_text || '').split(/\n\n+/).forEach(function(para){
        var t = para.trim();
        if(t.length >= 10) origParas.push({text: t, normText: norm(t), tag: 'p'});
      });
      // If no \n\n breaks, try single \n
      if(origParas.length <= 1 && section.original_text && section.original_text.length > 50){
        origParas = [];
        section.original_text.split(/\n/).forEach(function(para){
          var t = para.trim();
          if(t.length >= 10) origParas.push({text: t, normText: norm(t), tag: 'p'});
        });
      }

      // Parse draft into paragraphs (HTML)
      var draftTemp = document.createElement('div');
      draftTemp.innerHTML = section.draft_text;
      var draftParas = [];
      draftTemp.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote').forEach(function(el){
        draftParas.push({html: el.innerHTML, tag: el.tagName.toLowerCase(), text: el.textContent.trim()});
      });

      var sectionMatched = 0;

      // For each original paragraph, find matching DOM element and replace
      origParas.forEach(function(orig, idx){
        if(idx >= draftParas.length) return;
        var draft = draftParas[idx];

        var candidates = document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, span, div');
        var found = null;

        // Helper: skip elements with display/heading font sizes (>20px) to avoid breaking hero/CTA areas
        function isDisplayFont(el) {
          try { var fs = parseFloat(window.getComputedStyle(el).fontSize); return fs > 20; } catch(e) { return false; }
        }

        // Exact match on normalized text
        for(var i=0; i<candidates.length; i++){
          var el = candidates[i];
          if(replacedEls.has(el)) continue;
          if(el.closest(skipSelector)) continue;
          if(el.tagName !== 'P' && el.tagName !== 'LI' && el.querySelector('p,li,h1,h2,h3,h4,h5,h6')) continue;
          if(isDisplayFont(el)) continue;
          var elNorm = norm(el.textContent);
          if(elNorm === orig.normText){ found = el; break; }
        }

        // Fuzzy: first 50 chars match
        if(!found){
          var short = orig.normText.slice(0,50);
          if(short.length >= 15){
            for(var i=0; i<candidates.length; i++){
              var el = candidates[i];
              if(replacedEls.has(el)) continue;
              if(el.closest(skipSelector)) continue;
              if(el.tagName !== 'P' && el.tagName !== 'LI' && el.querySelector('p,li,h1,h2,h3,h4,h5,h6')) continue;
              if(isDisplayFont(el)) continue;
              var elNorm = norm(el.textContent);
              if(elNorm.length >= 15 && elNorm.slice(0,50) === short){ found = el; break; }
            }
          }
        }

        // Fuzzy: contains match
        if(!found && orig.normText.length >= 30){
          var snippet = orig.normText.slice(0,60);
          for(var i=0; i<candidates.length; i++){
            var el = candidates[i];
            if(replacedEls.has(el)) continue;
            if(el.closest(skipSelector)) continue;
            if(el.tagName !== 'P' && el.tagName !== 'LI' && el.querySelector('p,li,h1,h2,h3,h4,h5,h6')) continue;
            if(isDisplayFont(el)) continue;
            var elNorm = norm(el.textContent);
            if(elNorm.length >= 20 && elNorm.indexOf(snippet) !== -1){ found = el; break; }
          }
        }

        if(found){
          var oldText = norm(found.textContent);
          found.innerHTML = draft.html;
          replacedEls.add(found);
          if(norm(found.textContent) !== oldText){
            applyHL(found);
            totalReplacements++;
          }
          sectionMatched++;
        } else {
          console.log('[SEO Room] No DOM match for: "'+orig.normText.slice(0,50)+'..."');
        }
      });

      // Handle extra draft paragraphs
      if(draftParas.length > origParas.length && sectionMatched > 0){
        var lastReplaced = null;
        replacedEls.forEach(function(el){ lastReplaced = el; });
        if(lastReplaced){
          for(var extra = origParas.length; extra < draftParas.length; extra++){
            var dp = draftParas[extra];
            var newEl = document.createElement(dp.tag === 'li' ? 'p' : dp.tag);
            newEl.innerHTML = dp.html;
            applyHL(newEl);
            if(lastReplaced.className){
              var origClasses = lastReplaced.className.replace(/seo-text-hl/g,'').trim();
              if(origClasses) newEl.className = origClasses;
            }
            if(lastReplaced.nextSibling) lastReplaced.parentNode.insertBefore(newEl, lastReplaced.nextSibling);
            else lastReplaced.parentNode.appendChild(newEl);
            lastReplaced = newEl;
            totalReplacements++;
          }
        }
      }

      // Replace heading if changed
      if(section.original_heading && section.draft_heading){
        var headingNorm = norm(section.original_heading);
        var allH = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
        for(var i=0;i<allH.length;i++){
          if(replacedEls.has(allH[i])) continue;
          if(allH[i].closest(skipSelector)) continue;
          if(norm(allH[i].textContent) === headingNorm){
            if(norm(section.draft_heading) !== headingNorm){
              allH[i].textContent = section.draft_heading;
              applyHL(allH[i]);
              totalReplacements++;
            }
            replacedEls.add(allH[i]);
            break;
          }
        }
      }

      // Section types that already exist as design elements on the page — never duplicate them as "new"
      var noPromoteTypes = {cta:1, button:1, testimonial:1, testimonials:1, pricing:1, hero:1, image:1, gallery:1, form:1};
      if(sectionMatched > 0) matched++;
      else if(section.draft_text && !section.is_new && !noPromoteTypes[section.type]) {
        // No paragraphs matched — promote to NEW section so it gets inserted on the page
        section._unmatched = true;
        console.log('[SEO Room] Section "'+section.type+'" ('+(section.heading||'no heading').slice(0,30)+'): UNMATCHED — will insert as new section');
      } else if(sectionMatched === 0 && noPromoteTypes[section.type]) {
        console.log('[SEO Room] Section "'+section.type+'" skipped (design element, not promoted)');
      }
      console.log('[SEO Room] Section "'+section.type+'" ('+(section.heading||'no heading').slice(0,30)+'): '+sectionMatched+'/'+origParas.length+' paragraphs matched');
    });

    // Handle NEW sections + unmatched sections (insert on page)
    var newSections = sections.filter(function(s){ return s.is_new || s._unmatched; });
    if(newSections.length > 0){
      // Use Elementor's own class structure so the page's CSS styles everything automatically
      var isElementor = !!document.querySelector('.elementor');
      var sectionWrap = document.querySelector('.elementor-section-wrap, [data-elementor-type="wp-page"], [data-elementor-type="wp-post"]');
      var footer = document.querySelector('footer, .site-footer, .elementor-location-footer');
      var insertTarget = sectionWrap || (footer ? footer.parentNode : (document.querySelector('.entry-content, article, main') || document.body));
      var insertBefore = null;
      // Insert before footer if it's inside our target
      if(footer && insertTarget.contains(footer)) insertBefore = footer;
      // Fallback: insert before the last 2 Elementor sections (usually CTA + footer widgets)
      if(!insertBefore && isElementor) {
        var allTopSections = document.querySelectorAll('.elementor-top-section');
        if(allTopSections.length >= 3) insertBefore = allTopSections[allTopSections.length - 2];
      }

      // Inject a one-time stylesheet so new sections read as designed content blocks (matching site spacing/card feel)
      if(!document.getElementById('seo-new-block-css')){
        var st = document.createElement('style');
        st.id = 'seo-new-block-css';
        st.textContent = '.seo-new-block{padding:64px 0 !important;position:relative}'
          + '.seo-new-block .seo-card{padding:0;background:none;box-shadow:none}'
          + '.seo-new-block .elementor-widget-heading{margin-bottom:18px}'
          // Two-column split: heading left, body in a boxed card on the right with a blue accent
          + '.seo-split .seo-split-inner{max-width:1180px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:38% 1fr;gap:56px;align-items:flex-start}'
          + '.seo-split-left{padding-top:54px}'
          + '.seo-split-left .elementor-widget-heading{margin-bottom:0}'
          + '.seo-split-right{position:relative}'
          // Brand-coloured block sits to the LEFT and below the card (colour comes from --seo-accent, detected per site)
          + '.seo-split-right:before{content:"";position:absolute;inset:-16px 70px -26px -42px;background:var(--seo-accent,#1f4fe0);border-radius:22px;z-index:0;box-shadow:0 30px 60px rgba(2,6,23,.28)}'
          + '.seo-split-card{position:relative;z-index:1;background:#fff;border-radius:18px;box-shadow:0 30px 60px rgba(2,6,23,.16);padding:46px 50px}'
          + '.seo-split-card .elementor-widget-container,.seo-split-card p{margin-top:0}'
          + '@media(max-width:900px){.seo-split .seo-split-inner{grid-template-columns:1fr;gap:28px}.seo-split-left{padding-top:0}.seo-split-right:before{inset:-10px 60px -16px -14px}.seo-split-card{padding:32px 26px}}';
        document.head.appendChild(st);
      }

      // Pick the page's most representative widget of a kind (longest text, not in a skipped/design widget)
      function pickDonor(selector, minLen){
        var best=null, bestLen=0, els=document.querySelectorAll(selector);
        for(var i=0;i<els.length;i++){
          var el=els[i];
          if(el.closest(skipSelector)) continue;
          if(replacedEls.has(el)) continue;
          var t=(el.textContent||'').trim();
          if(t.length>bestLen){ bestLen=t.length; best=el; }
        }
        return bestLen>=(minLen||0) ? best : null;
      }
      // Remove Elementor's dynamic attributes from a clone so its JS doesn't re-init / collide
      function stripDyn(node){
        if(!node||node.nodeType!==1) return;
        var attrs=['id','data-id','data-settings','data-element_type','data-widget_type'];
        attrs.forEach(function(a){ node.removeAttribute(a); });
        var kids=node.querySelectorAll('['+attrs.join('],[')+']');
        for(var i=0;i<kids.length;i++){ attrs.forEach(function(a){ kids[i].removeAttribute(a); }); }
      }
      // Build a new section by cloning REAL heading + text widgets so the theme's CSS styles them
      function buildDesignedSection(headingText, bodyHtml){
        var donorTextContainer = pickDonor('.elementor-widget-text-editor .elementor-widget-container', 60);
        var donorTextWidget = donorTextContainer ? donorTextContainer.closest('.elementor-widget-text-editor') : null;
        if(!donorTextWidget) return null;
        var donorSection = donorTextWidget.closest('.elementor-top-section') || donorTextWidget.closest('section');
        // Body text colour — used to force headings visible (donor heading may be white-on-dark in its original section)
        var bodyColor=''; try{ bodyColor=window.getComputedStyle(donorTextContainer).color; }catch(e){}
        // Prefer the heading that lives in the SAME content section as the donor body — guarantees the page's real heading+body pairing/styling
        var donorHeadingWidget=null;
        if(donorSection){
          var hcand=donorSection.querySelectorAll('.elementor-widget-heading .elementor-heading-title');
          for(var i=0;i<hcand.length;i++){ if(!hcand[i].closest(skipSelector)){ donorHeadingWidget=hcand[i].closest('.elementor-widget-heading'); break; } }
        }
        // Fallback: any section-sized heading (20–60px), avoiding tiny eyebrow labels
        if(!donorHeadingWidget){
          var els=document.querySelectorAll('.elementor-widget-heading .elementor-heading-title'), best=null, bestFs=0;
          for(var j=0;j<els.length;j++){
            var el=els[j]; if(el.closest(skipSelector)) continue;
            var fs=0; try{ fs=parseFloat(window.getComputedStyle(el).fontSize)||0; }catch(e){}
            if(fs<20||fs>60) continue;
            if(fs>bestFs){ bestFs=fs; best=el; }
          }
          donorHeadingWidget = best ? best.closest('.elementor-widget-heading') : null;
        }

        var section=document.createElement('section');
        section.className='elementor-section elementor-top-section elementor-element elementor-section-boxed elementor-section-height-default seo-new-block';
        var container=document.createElement('div'); container.className='elementor-container elementor-column-gap-default';
        var column=document.createElement('div'); column.className='elementor-column elementor-col-100 elementor-top-column elementor-element';
        var wrap=document.createElement('div'); wrap.className='elementor-widget-wrap elementor-element-populated';
        column.appendChild(wrap); container.appendChild(column); section.appendChild(container);

        if(headingText){
          if(donorHeadingWidget){
            var hw=donorHeadingWidget.cloneNode(true); stripDyn(hw);
            hw.style.setProperty('background','transparent','important');
            var ht=hw.querySelector('.elementor-heading-title') || hw.querySelector('h1,h2,h3,h4,h5,h6');
            if(ht){ ht.textContent=headingText; ht.style.setProperty('text-align','left','important'); if(bodyColor) ht.style.setProperty('color', bodyColor, 'important'); }
            wrap.appendChild(hw);
          } else {
            var h=document.createElement('h2'); h.textContent=headingText;
            h.style.cssText='margin:0 0 14px;font-weight:700;font-size:30px;line-height:1.2;'+(bodyColor?'color:'+bodyColor+';':'');
            wrap.appendChild(h);
          }
        }
        var tw=donorTextWidget.cloneNode(true); stripDyn(tw);
        var tc=tw.querySelector('.elementor-widget-container');
        if(tc){ tc.innerHTML=bodyHtml; } else { tw.innerHTML='<div class="elementor-widget-container">'+bodyHtml+'</div>'; }
        wrap.appendChild(tw);
        return section;
      }

      // Shared: find a heading widget to clone (same-section preferred, else a section-sized heading)
      function findHeadingDonor(donorSection){
        var donor=null;
        if(donorSection){
          var hc=donorSection.querySelectorAll('.elementor-widget-heading .elementor-heading-title');
          for(var i=0;i<hc.length;i++){ if(!hc[i].closest(skipSelector)){ return hc[i].closest('.elementor-widget-heading'); } }
        }
        var els=document.querySelectorAll('.elementor-widget-heading .elementor-heading-title'), best=null, bestFs=0;
        for(var j=0;j<els.length;j++){ var el=els[j]; if(el.closest(skipSelector)) continue; var fs=0; try{fs=parseFloat(window.getComputedStyle(el).fontSize)||0;}catch(e){} if(fs<20||fs>60) continue; if(fs>bestFs){ bestFs=fs; best=el; } }
        return best ? best.closest('.elementor-widget-heading') : null;
      }

      // Find the page's testimonial section — used as the DESIGN SOURCE (fonts, heading style) for the split layout
      function getTestimonialSource(){
        var tw=document.querySelector('.elementor-widget-itestimonials,.elementor-widget-testimonial,.elementor-widget-testimonial-carousel,.elementor-widget-blockquote,[class*="testimonial"]');
        var tSection=tw?tw.closest('.elementor-top-section'):null;
        // Biggest heading anywhere in that section (the main title, not the small eyebrow)
        var headingWidget=null;
        if(tSection){
          var hs=tSection.querySelectorAll('.elementor-widget-heading .elementor-heading-title'), bestFs=0;
          for(var i=0;i<hs.length;i++){ var fs=0; try{fs=parseFloat(window.getComputedStyle(hs[i]).fontSize)||0;}catch(e){} if(fs>bestFs){ bestFs=fs; headingWidget=hs[i].closest('.elementor-widget-heading'); } }
        }
        // Body font from the testimonial's quote text
        var bodyFont='';
        if(tw){
          var qt=tw.querySelector('p,blockquote,[class*="content"],[class*="text"]')||tw;
          try{ var cs=window.getComputedStyle(qt); if(cs&&cs.fontFamily) bodyFont='font-family:'+cs.fontFamily+';'; }catch(e){}
        }
        return { section:tSection, headingWidget:headingWidget, bodyFont:bodyFont };
      }

      // Build a TWO-COLUMN section: heading on the left, body text in a boxed card on the right (testimonial-style)
      function buildSplitSection(headingText, bodyHtml){
        var donorTextContainer = pickDonor('.elementor-widget-text-editor .elementor-widget-container', 60);
        var donorTextWidget = donorTextContainer ? donorTextContainer.closest('.elementor-widget-text-editor') : null;
        var donorSection = donorTextWidget ? (donorTextWidget.closest('.elementor-top-section')||donorTextWidget.closest('section')) : null;
        var bodyColor=''; try{ if(donorTextContainer) bodyColor=window.getComputedStyle(donorTextContainer).color; }catch(e){}

        // Prefer the testimonial section as the design source so fonts match the real card
        var tsrc = getTestimonialSource();
        var donorHeadingWidget = tsrc.headingWidget || findHeadingDonor(donorSection);

        var section=document.createElement('section');
        section.className='elementor-section elementor-top-section elementor-element seo-new-block seo-split';
        var inner=document.createElement('div'); inner.className='seo-split-inner';
        var left=document.createElement('div'); left.className='seo-split-left';
        var right=document.createElement('div'); right.className='seo-split-right';

        if(headingText){
          if(donorHeadingWidget){
            var hw=donorHeadingWidget.cloneNode(true); stripDyn(hw);
            hw.style.setProperty('background','transparent','important');
            var ht=hw.querySelector('.elementor-heading-title')||hw.querySelector('h1,h2,h3,h4,h5,h6');
            if(ht){ ht.textContent=headingText; ht.style.setProperty('text-align','left','important'); if(bodyColor) ht.style.setProperty('color',bodyColor,'important'); }
            left.appendChild(hw);
          } else {
            var h=document.createElement('h2'); h.textContent=headingText;
            h.style.cssText='margin:0;font-weight:700;font-size:34px;line-height:1.15;'+(bodyColor?'color:'+bodyColor+';':'');
            left.appendChild(h);
          }
        }

        var card=document.createElement('div'); card.className='seo-split-card';
        if(donorTextWidget){
          var tw2=donorTextWidget.cloneNode(true); stripDyn(tw2);
          var tc2=tw2.querySelector('.elementor-widget-container');
          if(tc2){ tc2.innerHTML=bodyHtml; } else { tw2.innerHTML='<div class="elementor-widget-container">'+bodyHtml+'</div>'; }
          if(tsrc.bodyFont) tw2.setAttribute('style', (tw2.getAttribute('style')||'')+';'+tsrc.bodyFont);
          card.appendChild(tw2);
        } else { card.innerHTML=bodyHtml; }
        if(tsrc.bodyFont) card.setAttribute('style','text-align:left;'+tsrc.bodyFont);
        right.appendChild(card);

        inner.appendChild(left); inner.appendChild(right); section.appendChild(inner);
        return section;
      }

      newSections.forEach(function(ns){
        var heading = ns.draft_heading || ns.heading;
        var bodyHtml = ns.draft_text || '';
        var contentHtml = (heading ? '<h2>'+heading+'</h2>' : '') + bodyHtml;

        var section = null;
        if(isElementor){
          try { section = buildSplitSection(heading, bodyHtml); }
          catch(e0){ console.warn('[SEO Room] split build failed:', e0); section = null; }
          if(!section){
            try { section = buildDesignedSection(heading, bodyHtml); }
            catch(e){ console.warn('[SEO Room] designed clone failed, using fallback:', e); section = null; }
          }
        }
        if(!section){
          // Fallback: clean structure (no donor widget found, or non-Elementor page)
          section = document.createElement('section');
          if(isElementor){
            section.className='elementor-section elementor-top-section elementor-element elementor-section-boxed elementor-section-height-default seo-new-block';
            section.innerHTML='<div class="elementor-container elementor-column-gap-default"><div class="elementor-column elementor-col-100 elementor-top-column elementor-element"><div class="elementor-widget-wrap elementor-element-populated"><div class="seo-card"><div class="elementor-element elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container">'+contentHtml+'</div></div></div></div></div></div>';
          } else {
            section.className='seo-new-block';
            section.style.cssText='max-width:1140px;margin:40px auto;position:relative;';
            section.innerHTML='<div class="seo-card">'+contentHtml+'</div>';
          }
        }
        section.style.position='relative';

        var badge = document.createElement('div');
        badge.className = 'seo-new-badge';
        badge.textContent = 'NEW SECTION';
        section.appendChild(badge);

        // Use the reference node's real parent — insertTarget may not be its direct parent (caused NotFoundError)
        if(insertBefore && insertBefore.parentNode) insertBefore.parentNode.insertBefore(section, insertBefore);
        else if(insertTarget) insertTarget.appendChild(section);
        matched++;
      });
    }

    // Style preview FAQ accordions to mirror this site's real accordion (icon circle colour, question/answer colour + font)
    try { styleFaqToMatchSite(siteAccent); } catch(e){ console.warn('[SEO Room] FAQ styling skipped:', e); }

    // Update badge
    var countBadge = document.getElementById('seo-match-count');
    if(countBadge) countBadge.textContent = matched + ' of ' + total + ' sections, ' + totalReplacements + ' changes';
    console.log('[SEO Room] Done: '+matched+'/'+total+' sections, '+totalReplacements+' text replacements');

    // === DEBUG PANEL ===
    var debugDiv = document.createElement('div');
    debugDiv.id = 'seo-debug-panel';
    debugDiv.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:60px;z-index:999998;background:rgba(0,0,0,0.95);color:#e5e7eb;overflow:auto;padding:20px;font-family:monospace;font-size:12px';
    var debugHtml = '<h3 style="color:#f59e0b;margin:0 0 12px">SEO Room Debug - Paragraph Matching</h3>';

    debugHtml += '<h4 style="color:#22c55e;margin:12px 0 6px">Page paragraphs found (first 80 chars):</h4>';
    var pagePs = document.querySelectorAll('p');
    var pagePCount = 0;
    pagePs.forEach(function(p){
      if(p.closest('form,footer,nav,header,.seo-preview-bar,.seo-debug-panel,#seo-debug-panel')) return;
      var t = p.textContent.trim();
      if(t.length < 10) return;
      pagePCount++;
      var normT = norm(t);
      debugHtml += '<div style="margin:2px 0;padding:2px 4px;border-left:2px solid #22c55e">['+p.tagName+'] "' + normT.slice(0,80) + '..."</div>';
    });
    debugHtml += '<div style="color:#22c55e;margin:4px 0">Total: '+pagePCount+' paragraphs</div>';

    sections.forEach(function(section){
      if(section.is_new) return;
      debugHtml += '<h4 style="color:#f59e0b;margin:16px 0 6px">Section: ' + (section.heading||section.type||'?').slice(0,40) + '</h4>';
      if(!section.original_text){
        debugHtml += '<div style="color:#ef4444">No original_text!</div>';
        return;
      }
      var debugParas = (section.original_text||'').split(/\n\n+/).filter(function(p){return p.trim().length>=10;});
      if(debugParas.length<=1 && section.original_text && section.original_text.length>50){
        debugParas = (section.original_text||'').split(/\n/).filter(function(p){return p.trim().length>=10;});
      }
      debugParas.forEach(function(para){
        var t = para.trim();
        var n = norm(t);
        var found = false;
        var allTextEls = document.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,span,div,blockquote');
        allTextEls.forEach(function(pp){
          if(pp.closest('form,footer,nav,header,.seo-preview-bar,#seo-debug-panel')) return;
          var ppN = norm(pp.textContent);
          if(ppN === n) found = true;
          if(!found && n.length >= 30 && ppN.length >= 30 && ppN.slice(0,50) === n.slice(0,50)) found = true;
        });
        var color = found ? '#22c55e' : '#ef4444';
        var label = found ? 'FOUND' : 'NOT FOUND';
        debugHtml += '<div style="margin:2px 0;padding:2px 4px;border-left:2px solid '+color+'">['+label+'] "' + n.slice(0,80) + '..."</div>';
      });
    });

    debugDiv.innerHTML = debugHtml;
    document.body.appendChild(debugDiv);

    // Add debug button to preview bar
    var debugBtn = document.createElement('button');
    debugBtn.textContent = 'Debug';
    debugBtn.style.cssText = 'background:rgba(239,68,68,0.3);color:#fff;border:1px solid rgba(239,68,68,0.6);padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600';
    debugBtn.onclick = function(){ var d = document.getElementById('seo-debug-panel'); d.style.display = d.style.display==='none'?'block':'none'; };
    var bar = document.querySelector('.seo-preview-bar');
    if(bar) bar.appendChild(debugBtn);
  }

  // Run after full page load (Elementor needs time to render)
  if(document.readyState==='complete') setTimeout(run,1200);
  else window.addEventListener('load',function(){ setTimeout(run,1200); });

  // Disable link clicks
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&!a.closest('.seo-preview-bar')){e.preventDefault();e.stopPropagation();}
  },true);
})();
