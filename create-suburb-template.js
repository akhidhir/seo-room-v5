// Suburb Template Builder — creates Elementor page on WordPress
// Run: node create-suburb-template.js

const rid = () => Math.random().toString(16).slice(2, 9);

// ─── Section helper ────────────────────────────────────────────
function section(settings, columns) {
  return { id: rid(), elType: 'section', settings: settings || {}, elements: columns };
}
function col(size, widgets) {
  return { id: rid(), elType: 'column', settings: { _column_size: size, _inline_size: size }, elements: widgets };
}
function widget(type, settings) {
  return { id: rid(), elType: 'widget', widgetType: type, settings: settings || {} };
}

// ─── Build the 9-section template ──────────────────────────────
const tree = [];

// ============================================================
// SECTION 1: HERO (full-width, bg image, 2 columns)
// ============================================================
tree.push(section({
  layout: 'full_width',
  height: 'min-height',
  custom_height: { size: 520, unit: 'px' },
  background_background: 'classic',
  background_image: { url: 'https://sureflow.seoroom.au/wp-content/uploads/2026/04/get-fixed-professional-plumber-wearing-tool-belt-2022-02-22-05-13-25-utc-min.jpg', id: '' },
  background_overlay_background: 'classic',
  background_overlay_color: 'rgba(0,30,28,0.5)',
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '60', right: '60', bottom: '60', left: '60', unit: 'px' }
}, [
  col(60, [
    widget('text-editor', {
      editor: '<p style="display:inline-block;background:#81C2B2;color:#fff;padding:4px 14px;border-radius:4px;font-size:13px;font-weight:600;">Lorem Ipsum Dolor Sit Amet</p>'
    }),
    widget('heading', {
      title: 'Lorem Ipsum Dolor Sit Amet',
      header_size: 'h1',
      title_color: '#FFFFFF',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 48, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('text-editor', {
      editor: '<p style="color:rgba(255,255,255,0.85);font-size:15px;line-height:1.65;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>',
    }),
    widget('icon-list', {
      icon_list: [
        { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit', selected_icon: { value: 'fas fa-check-double', library: 'fa-solid' } },
        { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit', selected_icon: { value: 'fas fa-check-double', library: 'fa-solid' } }
      ],
      icon_color: '#81C2B2',
      text_color: '#FFFFFF',
      typography_typography: 'custom',
      typography_font_size: { size: 15, unit: 'px' }
    }),
    widget('button', {
      text: 'Call Us Now!',
      selected_icon: { value: 'fas fa-phone-alt', library: 'fa-solid' },
      button_type: 'default',
      background_color: '#006E68',
      border_radius: { top: '100', right: '100', bottom: '100', left: '100', unit: 'px' },
      typography_typography: 'custom',
      typography_font_family: 'Space Grotesk',
      typography_font_size: { size: 23, unit: 'px' },
      typography_font_weight: '600',
      text_padding: { top: '8', right: '30', bottom: '8', left: '30', unit: 'px' }
    })
  ]),
  col(40, [
    widget('text-editor', {
      editor: `<div style="background:#fff;border-radius:12px;padding:30px;box-shadow:0 8px 30px rgba(0,0,0,0.15);">
        <h3 style="font-family:'Familjen Grotesk',sans-serif;font-size:22px;text-align:center;margin-bottom:20px;color:#10202E;">Excepteur sint occaecat cupidatat non proident</h3>
        <input type="text" placeholder="Your Name" style="width:100%;padding:14px 16px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box;">
        <input type="email" placeholder="Your Email" style="width:100%;padding:14px 16px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box;">
        <select style="width:100%;padding:14px 16px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box;color:#7D8393;"><option>Gas Line Services</option></select>
        <input type="tel" placeholder="Your Phone" style="width:100%;padding:14px 16px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box;">
        <button style="width:100%;padding:15px 30px;background:#81C2B2;color:#fff;border:none;border-radius:100px;font-size:16px;font-weight:600;cursor:pointer;">Get A Quote</button>
      </div>`
    })
  ])
]));

// ============================================================
// SECTION 2: SERVICE STRIP (teal bg, 6 icon-boxes)
// ============================================================
const serviceStripCols = [];
for (let i = 0; i < 6; i++) {
  serviceStripCols.push(col(16, [
    widget('icon-box', {
      selected_icon: { value: 'fas fa-wrench', library: 'fa-solid' },
      title_text: 'Service ' + (i + 1),
      description_text: '',
      icon_space: { size: 10, unit: 'px' },
      title_typography_typography: 'custom',
      title_typography_font_size: { size: 14, unit: 'px' },
      title_typography_font_weight: '600',
      title_color: '#FFFFFF',
      primary_color: 'rgba(255,255,255,0.7)',
      position: 'top',
      title_bottom_space: { size: 0, unit: 'px' }
    })
  ]));
}
tree.push(section({
  layout: 'full_width',
  background_background: 'classic',
  background_color: '#006E68',
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '24', right: '10', bottom: '24', left: '10', unit: 'px' }
}, serviceStripCols));

// ============================================================
// SECTION 3: TOP SERVICE IN DEMAND
// ============================================================
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '60', right: '20', bottom: '60', left: '20', unit: 'px' }
}, [
  col(100, [
    widget('heading', {
      title: 'Top Service in Demand in [Suburb]',
      header_size: 'h2',
      title_color: '#10202E',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 25, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('text-editor', {
      editor: '<p style="color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit</p><p style="color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p><p style="color:#7D8393;">Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.</p><p style="color:#7D8393;">Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.</p><p style="color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.</p><p style="color:#7D8393;">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.</p>'
    }),
    widget('image', {
      image: { url: '', id: '' },
      image_size: 'full',
      caption: 'Landscape Image Placeholder'
    })
  ])
]));

// ============================================================
// SECTION 4: CTA CALL BAR
// ============================================================
function ctaBarSection(subtitle) {
  return section({
    layout: 'full_width',
    background_background: 'classic',
    background_color: '#006E68',
    padding: { top: '28', right: '60', bottom: '28', left: '60', unit: 'px' }
  }, [
    col(100, [
      widget('text-editor', {
        editor: `<div style="display:flex;align-items:center;gap:20px;">
          <div style="width:54px;height:54px;border:2px solid rgba(255,255,255,0.4);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
          </div>
          <div>
            <div style="font-size:14px;color:rgba(255,255,255,0.8);">${subtitle}</div>
            <div style="font-size:15px;font-weight:700;color:#fff;font-family:'Familjen Grotesk',sans-serif;">CALL US NOW!</div>
            <div style="font-size:28px;font-weight:700;color:#fff;font-family:'Familjen Grotesk',sans-serif;">0400 838 622</div>
          </div>
        </div>`
      })
    ])
  ]);
}
tree.push(ctaBarSection('Need a plumber in [Suburb] right now?'));

// ============================================================
// SECTION 5: SERVICE BLOCKS (alternating layout)
// ============================================================
function serviceBlock(heading, reversed) {
  const textCol = col(50, [
    widget('heading', {
      title: heading,
      header_size: 'h2',
      title_color: '#10202E',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 25, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('text-editor', {
      editor: '<p style="color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p><p style="color:#7D8393;">Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>'
    }),
    widget('button', {
      text: 'SERVICE NAME',
      button_type: 'default',
      background_color: 'transparent',
      button_text_color: '#10202E',
      border_border: 'solid',
      border_width: { top: '2', right: '2', bottom: '2', left: '2', unit: 'px' },
      border_color: '#10202E',
      border_radius: { top: '100', right: '100', bottom: '100', left: '100', unit: 'px' },
      typography_typography: 'custom',
      typography_font_size: { size: 16, unit: 'px' },
      typography_font_weight: '600'
    })
  ]);
  const imgCol = col(50, [
    widget('image', {
      image: { url: '', id: '' },
      image_size: 'full',
      caption: 'Service Image'
    })
  ]);
  const cols = reversed ? [imgCol, textCol] : [textCol, imgCol];
  return section({
    content_width: { size: 1200, unit: 'px' },
    padding: { top: '50', right: '20', bottom: '50', left: '20', unit: 'px' },
    column_gap: { size: 50, unit: 'px' }
  }, cols);
}

tree.push(serviceBlock('Service KW + [Suburb]', false));
tree.push(serviceBlock('Service KW + [Suburb]', true));
tree.push(serviceBlock('Service KW + [Suburb]', false));
tree.push(ctaBarSection('Looking for a reliable plumber in [Suburb]?'));
tree.push(serviceBlock('Service KW + [Suburb]', true));

// ============================================================
// SECTION 6: WHY CHOOSE US
// ============================================================
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '60', right: '20', bottom: '60', left: '20', unit: 'px' },
  column_gap: { size: 50, unit: 'px' }
}, [
  col(50, [
    widget('image', {
      image: { url: '', id: '' },
      image_size: 'full',
      caption: 'Company Image Collage'
    })
  ]),
  col(50, [
    widget('text-editor', {
      editor: '<p style="display:inline-block;background:#81C2B2;color:#fff;padding:4px 14px;border-radius:4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">ABOUT US</p>'
    }),
    widget('heading', {
      title: 'Lorem Ipsum Dolor',
      header_size: 'h2',
      title_color: '#10202E',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 25, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('text-editor', {
      editor: '<p style="color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper mattis, pulvinar dapibus leo.</p>'
    }),
    widget('icon-list', {
      icon_list: [
        { text: 'A Proficient Team', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } },
        { text: 'Reasonable Cost', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } },
        { text: 'Speedy Assistance', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } },
        { text: 'Supplies & Equipment', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } },
        { text: 'Projects (Big And Small)', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } },
        { text: 'Emergency Support', selected_icon: { value: 'far fa-circle', library: 'fa-regular' } }
      ],
      icon_color: '#81C2B2',
      text_color: '#10202E'
    }),
    widget('text-editor', {
      editor: '<div style="background:#81C2B2;border-radius:12px;padding:20px 24px;color:#fff;font-size:14px;line-height:1.6;margin-top:20px;">Phasellus vestibulum lorem sed risus ultricies tristique. At in tellus integer feugiat scelerisque varius morbi enim nunc. Facilisi morbi tempus iaculis urna id volutpat lacus laoreet.</div>'
    })
  ])
]));

// ============================================================
// SECTION 7: COMPANY'S DIFFERENCES (4-column cards)
// ============================================================
const diffCols = [];
const diffIcons = ['fas fa-th-large', 'fas fa-user', 'far fa-clock', 'far fa-credit-card'];
for (let i = 0; i < 4; i++) {
  const isEven = i % 2 === 1;
  diffCols.push(col(25, [
    widget('icon-box', {
      selected_icon: { value: diffIcons[i], library: i < 2 ? 'fa-solid' : 'fa-regular' },
      title_text: 'Lorem Ipsum Consectetur Adipiscing',
      description_text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      position: 'top',
      primary_color: isEven ? '#FFFFFF' : '#006E68',
      title_color: isEven ? '#FFFFFF' : '#10202E',
      description_color: isEven ? 'rgba(255,255,255,0.85)' : '#7D8393',
      icon_space: { size: 16, unit: 'px' }
    })
  ]));
}
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '60', right: '0', bottom: '0', left: '0', unit: 'px' },
  gap: { size: 0, unit: 'px' },
  column_gap: { size: 0, unit: 'px' }
}, diffCols));

// ============================================================
// SECTION 7b: ASSURANCE / PROMISE
// ============================================================
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '80', right: '20', bottom: '80', left: '20', unit: 'px' },
  column_gap: { size: 40, unit: 'px' }
}, [
  col(45, [
    widget('image', {
      image: { url: '', id: '' },
      image_size: 'full',
      caption: 'Plumber Photo'
    })
  ]),
  col(55, [
    widget('text-editor', {
      editor: `<div style="background:#006E68;border-radius:20px;padding:50px 40px;color:#fff;">
        <h2 style="font-family:'Familjen Grotesk',sans-serif;font-size:25px;font-weight:700;color:#fff;margin-bottom:14px;">Lorem Ipsum Dolor</h2>
        <p style="color:rgba(255,255,255,0.85);margin-bottom:16px;">Vel quam elementum pulvinar etiam non. Pretium fusce id velit ut tortor pretium. Urna condimentum mattis pellentesque id nibh tortor id. Vel orci porta non pulvinar neque.</p>
        <ul style="list-style:none;padding:0;margin:0 0 20px 0;">
          <li style="display:flex;align-items:center;gap:10px;color:#fff;font-size:15px;font-weight:500;padding:5px 0;"><span style="width:10px;height:10px;border-radius:50%;background:#81C2B2;flex-shrink:0;"></span> Deliver Top-Notch Plumbing Service</li>
          <li style="display:flex;align-items:center;gap:10px;color:#fff;font-size:15px;font-weight:500;padding:5px 0;"><span style="width:10px;height:10px;border-radius:50%;background:#81C2B2;flex-shrink:0;"></span> Provide Excellent Plumbing Service</li>
          <li style="display:flex;align-items:center;gap:10px;color:#fff;font-size:15px;font-weight:500;padding:5px 0;"><span style="width:10px;height:10px;border-radius:50%;background:#81C2B2;flex-shrink:0;"></span> We Ensure Your Full Satisfaction</li>
        </ul>
        <div style="margin-top:20px;">
          <div style="font-size:14px;color:#fff;font-weight:600;margin-bottom:4px;">Satisfaction</div>
          <div style="height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin-bottom:12px;"><div style="height:100%;width:92%;background:#81C2B2;border-radius:2px;"></div></div>
          <div style="font-size:14px;color:#fff;font-weight:600;margin-bottom:4px;">Working hard to ensure</div>
          <div style="height:4px;background:rgba(255,255,255,0.2);border-radius:2px;"><div style="height:100%;width:85%;background:#81C2B2;border-radius:2px;"></div></div>
        </div>
      </div>`
    })
  ])
]));

// ============================================================
// SECTION 8: SERVICE AREA LIST
// ============================================================
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '60', right: '20', bottom: '60', left: '20', unit: 'px' }
}, [
  col(100, [
    widget('heading', {
      title: 'Service Area List',
      header_size: 'h2',
      title_color: '#10202E',
      align: 'center',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 25, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('text-editor', {
      editor: '<p style="text-align:center;color:#7D8393;">Lorem ipsum dolor sit amet, consectetur adipiscing elit</p>'
    }),
    widget('text-editor', {
      editor: `<div style="display:grid;grid-template-columns:240px 1fr;gap:0;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0;">
        <div style="background:#fff;">
          <div style="padding:14px 20px;background:#006E68;color:#fff;border-radius:100px;margin:10px;text-align:center;font-weight:600;font-size:15px;">Group Of Suburb</div>
          <div style="padding:14px 20px;font-size:15px;font-weight:600;color:#006E68;border-bottom:1px solid #f0f0f0;">Group Of Suburb</div>
          <div style="padding:14px 20px;font-size:15px;font-weight:600;color:#006E68;border-bottom:1px solid #f0f0f0;">Group Of Suburb</div>
          <div style="padding:14px 20px;font-size:15px;font-weight:600;color:#006E68;border-bottom:1px solid #f0f0f0;">Group Of Suburb</div>
          <div style="padding:14px 20px;font-size:15px;font-weight:600;color:#006E68;border-bottom:1px solid #f0f0f0;">Group Of Suburb</div>
          <div style="padding:14px 20px;font-size:15px;font-weight:600;color:#006E68;">Group Of Suburb</div>
        </div>
        <div style="background:#F7F7F7;padding:30px 40px;display:grid;grid-template-columns:1fr 1fr;gap:6px 40px;">
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
          <div style="font-size:14px;color:#7D8393;padding:5px 0;">• Suburb</div>
        </div>
      </div>`
    })
  ])
]));

// ============================================================
// SECTION 8b: BRANDS STRIP
// ============================================================
tree.push(section({
  content_width: { size: 1200, unit: 'px' },
  padding: { top: '30', right: '20', bottom: '30', left: '20', unit: 'px' },
  border_border: 'solid',
  border_width: { top: '1', right: '0', bottom: '0', left: '0', unit: 'px' },
  border_color: '#eeeeee'
}, [
  col(100, [
    widget('text-editor', {
      editor: '<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:30px;align-items:center;">' +
        Array(12).fill('<div style="width:120px;height:40px;background:#f0f0f0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#999;font-weight:600;">Logoipsum</div>').join('') +
        '</div>'
    })
  ])
]));

// ============================================================
// SECTION 9: FAQ (optional — can be added later)
// ============================================================
tree.push(section({
  background_background: 'classic',
  background_color: '#F7F7F7',
  content_width: { size: 900, unit: 'px' },
  padding: { top: '60', right: '20', bottom: '60', left: '20', unit: 'px' }
}, [
  col(100, [
    widget('heading', {
      title: 'Frequently Asked Questions',
      header_size: 'h2',
      title_color: '#10202E',
      align: 'center',
      typography_typography: 'custom',
      typography_font_family: 'Familjen Grotesk',
      typography_font_size: { size: 25, unit: 'px' },
      typography_font_weight: '700'
    }),
    widget('accordion', {
      tabs: [
        { tab_title: 'Lorem ipsum dolor sit amet?', tab_content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.' },
        { tab_title: 'Ut enim ad minim veniam?', tab_content: 'Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.' },
        { tab_title: 'Duis aute irure dolor in reprehenderit?', tab_content: 'In voluptate velit esse cillum dolore eu fugiat nulla pariatur.' },
        { tab_title: 'Excepteur sint occaecat cupidatat?', tab_content: 'Non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.' }
      ]
    })
  ])
]));

// ─── Output ────────────────────────────────────────────────────
console.log(JSON.stringify(tree));
console.log('\n--- ' + tree.length + ' sections built ---');
