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

  function run(){
    var dataEl = document.getElementById('seo-section-data');
    if(!dataEl){ console.log('[SEO Room] No section data found'); return; }
    var sections = JSON.parse(dataEl.textContent);
    var matched = 0;
    var totalReplacements = 0;
    var total = sections.filter(function(s){return !s.is_new;}).length;

    console.log('[SEO Room] Starting DIRECT paragraph matching for '+sections.length+' sections');

    var skipSelector = 'form,footer,nav,header,.seo-preview-bar,.widget,.sidebar,.elementor-widget-form,.elementor-form,.wpcf7,.wpforms-container,.gform_wrapper,.site-footer,.footer-widget,.elementor-location-footer';
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

        // Exact match on normalized text
        for(var i=0; i<candidates.length; i++){
          var el = candidates[i];
          if(replacedEls.has(el)) continue;
          if(el.closest(skipSelector)) continue;
          if(el.tagName !== 'P' && el.tagName !== 'LI' && el.querySelector('p,li,h1,h2,h3,h4,h5,h6')) continue;
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

      if(sectionMatched > 0) matched++;
      console.log('[SEO Room] Section "'+section.type+'" ('+(section.heading||'no heading').slice(0,30)+'): '+sectionMatched+'/'+origParas.length+' paragraphs matched');
    });

    // Handle NEW sections
    var newSections = sections.filter(function(s){ return s.is_new; });
    if(newSections.length > 0){
      var footer = document.querySelector('footer, .site-footer, .elementor-location-footer');
      var contentArea = document.querySelector('.entry-content, .page-content, .post-content, article, main, #content, .site-content, .elementor-section-wrap') || document.body;
      // Find an existing content section to clone styling from
      var templateSection = document.querySelector('.elementor-section.elementor-top-section:not(.elementor-section-full_width)') ||
                            document.querySelector('.elementor-section.elementor-top-section') ||
                            document.querySelector('section.elementor-section') ||
                            document.querySelector('.entry-content > *:last-child');
      var templateStyles = templateSection ? window.getComputedStyle(templateSection) : null;

      newSections.forEach(function(ns){
        var block = document.createElement('div');
        block.className = 'seo-new-block';
        block.style.position = 'relative';
        // Copy key layout styles from existing section to match the page design
        if(templateStyles){
          block.style.maxWidth = templateStyles.maxWidth || '1140px';
          block.style.margin = '0 auto';
          block.style.padding = templateStyles.padding || '40px 20px';
          block.style.boxSizing = 'border-box';
          block.style.fontFamily = templateStyles.fontFamily;
          block.style.fontSize = templateStyles.fontSize || '16px';
          block.style.lineHeight = templateStyles.lineHeight || '1.6';
          block.style.color = templateStyles.color || '#333';
        } else {
          block.style.maxWidth = '1140px';
          block.style.margin = '0 auto';
          block.style.padding = '40px 20px';
          block.style.lineHeight = '1.6';
        }
        // Copy heading styles from existing headings
        var heading = ns.draft_heading || ns.heading;
        var existingH2 = document.querySelector('h2:not(.seo-new-block h2)');
        var h2Style = existingH2 ? window.getComputedStyle(existingH2) : null;
        var headingHtml = '';
        if(heading){
          headingHtml = '<h2 style="' +
            (h2Style ? 'font-family:'+h2Style.fontFamily+';font-size:'+h2Style.fontSize+';font-weight:'+h2Style.fontWeight+';color:'+h2Style.color+';line-height:'+h2Style.lineHeight+';margin:'+h2Style.margin+';' : '') +
            '">' + heading + '</h2>';
        }
        // Copy paragraph styles from existing paragraphs
        var existingP = document.querySelector('.entry-content p, .elementor-widget-text-editor p, article p');
        var pStyle = existingP ? window.getComputedStyle(existingP) : null;
        var draftHtml = ns.draft_text || '';
        if(pStyle){
          // Wrap plain text paragraphs with matching styles
          var pStyleStr = 'font-family:'+pStyle.fontFamily+';font-size:'+pStyle.fontSize+';line-height:'+pStyle.lineHeight+';color:'+pStyle.color+';margin:'+pStyle.margin+';';
          draftHtml = draftHtml.replace(/<p>/g, '<p style="'+pStyleStr+'">');
          draftHtml = draftHtml.replace(/<li>/g, '<li style="'+pStyleStr+'">');
        }
        block.innerHTML = headingHtml + draftHtml;
        var badge = document.createElement('div');
        badge.className = 'seo-new-badge';
        badge.textContent = 'NEW SECTION';
        block.appendChild(badge);
        // Insert before footer or at end of content
        if(footer && footer.parentNode) footer.parentNode.insertBefore(block, footer);
        else contentArea.appendChild(block);
        matched++;
      });
    }

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
