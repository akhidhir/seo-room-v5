const https = require('https');
const BASE = 'https://seo-room-v5-production.up.railway.app';

function post(projectId, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${BASE}/api/projects/${projectId}/rc-sync`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`Project ${projectId}: ${res.statusCode} - ${body.substring(0, 300)}`);
        resolve(body);
      });
    });
    req.on('error', e => { console.error(`Project ${projectId} error:`, e.message); reject(e); });
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('=== Syncing Project 1: Houseworks ===');
  await post(1, {
    location_id: 'locations/12755344744730282615',
    profile: {
      name: 'locations/12755344744730282615', title: 'Houseworks Plumbing & Gas',
      phoneNumbers: { primaryPhone: '(08) 6400 5390' },
      categories: {
        primaryCategory: { name: 'categories/gcid:plumber', displayName: 'Plumber' },
        additionalCategories: [
          { name: 'categories/gcid:drainage_service', displayName: 'Drainage Service' },
          { name: 'categories/gcid:bathroom_remodeler', displayName: 'Bathroom Renovator' },
          { name: 'categories/gcid:gas_installation_service', displayName: 'Gas installation service' },
          { name: 'categories/gcid:hot_water_system_supplier', displayName: 'Hot water system supplier' }
        ]
      },
      storefrontAddress: { regionCode: 'AU', postalCode: '6149', administrativeArea: 'WA', locality: 'Leeming' },
      websiteUri: 'https://houseworksplumbing.com.au/',
      regularHours: { periods: [
        {openDay:'MONDAY',openTime:{hours:7},closeDay:'MONDAY',closeTime:{hours:16}},
        {openDay:'TUESDAY',openTime:{hours:7},closeDay:'TUESDAY',closeTime:{hours:16}},
        {openDay:'WEDNESDAY',openTime:{hours:7},closeDay:'WEDNESDAY',closeTime:{hours:16}},
        {openDay:'THURSDAY',openTime:{hours:7},closeDay:'THURSDAY',closeTime:{hours:16}},
        {openDay:'FRIDAY',openTime:{hours:7},closeDay:'FRIDAY',closeTime:{hours:16}}
      ]},
      serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY', places: { placeInfos: [
        {placeName:'Perth WA, Australia',placeId:'ChIJPXNH22yWMioR0FXfNbXwBAM'},
        {placeName:'Leeming WA 6149, Australia',placeId:'ChIJnwYx9SO9MioRoEnfNbXwBAU'},
        {placeName:'Melville WA 6156, Australia',placeId:'ChIJVa6UerGiMioREEvfNbXwBAU'}
      ]}},
      profile: { description: "Houseworks Plumbing & Gas is a specialist Plumbing located in Leeming, WA. The services we offer include Leaking Taps, Burst Pipes, Blocked Drains, Hot Water Units, and Water filters. Although we are located in Leeming, we service clients from areas such as Fremantle, Spearwood, Hamilton Hill, Mosman Park, White Gum Valley, Attadale, Palmyra, Bicton, Murdoch, Bateman, North Lake, Bull Creek, Willetton, South Lake, Kardinya, Jandakot, Winthrop, Atwell, South Perth, Como, and all surrounding areas. If you are looking for the best Plumbing in Leeming, look no further." },
      serviceItems: [
        {structuredServiceItem:{serviceTypeId:'job_type_id:install_faucet'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_faucet'}},{structuredServiceItem:{serviceTypeId:'job_type_id:find_leak'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_pipe'}},{structuredServiceItem:{serviceTypeId:'job_type_id:install_shower'}},{structuredServiceItem:{serviceTypeId:'job_type_id:install_toilet'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_toilet'}},{structuredServiceItem:{serviceTypeId:'job_type_id:install_water_heater'}},{structuredServiceItem:{serviceTypeId:'job_type_id:unclog_drain'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_outdoor_systems'}},{structuredServiceItem:{serviceTypeId:'job_type_id:plumbing_leak_repair'}},{structuredServiceItem:{serviceTypeId:'job_type_id:sewer_cleaning'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_sewer'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_shower'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_water_heater'}},
        {freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Bathroom & Laundry Renovations'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Burst Pipes'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Clearing Blocked Drains'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Commercial & Industrial'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Emergency Callout'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Gas Bayonets'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Gas Fitter'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Gas Leaks'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Gas Systems'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Heating Systems'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Home & Commercial Plumbing Services'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Hot Water Units'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Leaking Taps'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'New Gas Installations'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumbing & Gas Emergencies'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumbing Needs'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Residential And Commercial'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Water Filters'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Bbq Installs'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Blocked Drains'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Commercial Plumbing & Gas'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Emergency Gas'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Emergency Plumbing'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Home Plumbing'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Maintenance & Repair'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'New Home'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Ongoing Maintenance'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Pipes Blocked'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumbing Maintenance'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Residential And Commercial Properties'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Reticulation System'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Shower Screens'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Water Line'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumber Leeming'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Residential Plumber Perth'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumber Winthrop'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Plumber Willagee'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Rheem Hot Water Systems'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Rinnai Hot Water Systems'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Leaking Toilet Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:plumber',label:{displayName:'Leaking Shower Repairs'}}}
      ],
      metadata: { placeId: 'ChIJmdiEtgK9MioRF4p_205czqE' }
    },
    reviews_stats: {total_reviews:119,average_rating:4.71,reply_rate:79.8,replied_count:95,unreplied_count:24}
  });

  console.log('\n=== Syncing Project 2: Gold PC ===');
  await post(2, {
    location_id: 'locations/8702513397324148400',
    profile: {
      name: 'locations/8702513397324148400', title: 'Gold PC Services',
      phoneNumbers: { primaryPhone: '(08) 9271 9924' },
      categories: {
        primaryCategory: { name: 'categories/gcid:computer_repair_service', displayName: 'Computer repair service' },
        additionalCategories: [
          { name: 'categories/gcid:computer_store', displayName: 'Computer Shop' },
          { name: 'categories/gcid:computer_service', displayName: 'Computer service' },
          { name: 'categories/gcid:data_recovery_service', displayName: 'Data recovery service' },
          { name: 'categories/gcid:computer_hardware_manufacturer', displayName: 'Computer Hardware Company' }
        ]
      },
      storefrontAddress: { regionCode: 'AU', postalCode: '6053', administrativeArea: 'WA', locality: 'Bayswater', addressLines: ['U A 8 King William Street'] },
      websiteUri: 'https://goldpc.net.au/',
      regularHours: { periods: [
        {openDay:'MONDAY',openTime:{hours:10},closeDay:'MONDAY',closeTime:{hours:16}},
        {openDay:'TUESDAY',openTime:{hours:10},closeDay:'TUESDAY',closeTime:{hours:16}},
        {openDay:'WEDNESDAY',openTime:{hours:10},closeDay:'WEDNESDAY',closeTime:{hours:16}},
        {openDay:'THURSDAY',openTime:{hours:10},closeDay:'THURSDAY',closeTime:{hours:16}},
        {openDay:'FRIDAY',openTime:{hours:10},closeDay:'FRIDAY',closeTime:{hours:16}}
      ]},
      serviceArea: { businessType: 'CUSTOMER_AND_BUSINESS_LOCATION', places: { placeInfos: [
        {placeName:'Perth, WA, Australia',placeId:'ChIJC4Rr0Cq7MioRAFPLcwKhtHI'},
        {placeName:'Ascot WA 6104, Australia',placeId:'ChIJpdh70zO6MioRID7fNbXwBAU'},
        {placeName:'Morley WA 6062, Australia',placeId:'ChIJU_dpGJCwMioRoEvfNbXwBAU'},
        {placeName:'Belmont WA 6104, Australia',placeId:'ChIJw23v7I-7MioRsD_fNbXwBAU'},
        {placeName:'Noranda WA 6062, Australia',placeId:'ChIJHaAO81ewMioRIE3fNbXwBAU'},
        {placeName:'Subiaco WA 6008, Australia',placeId:'ChIJcfF77xalMioREFLfNbXwBAU'},
        {placeName:'Dianella WA 6059, Australia',placeId:'ChIJy9ZCIj6wMioRIEPfNbXwBAU'},
        {placeName:'Maylands WA 6051, Australia',placeId:'ChIJSUVf81e6MioR0ErfNbXwBAU'},
        {placeName:'Bayswater WA 6053, Australia',placeId:'ChIJkSZrj266MioRAD_fNbXwBAU'},
        {placeName:'Beechboro WA 6063, Australia',placeId:'ChIJ0dJunFG3MioRUD_fNbXwBAU'},
        {placeName:'Guildford WA 6055, Australia',placeId:'ChIJ2aJf4ty5MioRgEXfNbXwBAU'},
        {placeName:'Inglewood WA 6052, Australia',placeId:'ChIJQR_MlZm6MioREEffNbXwBAU'},
        {placeName:'Bassendean WA 6054, Australia',placeId:'ChIJLSl-sB26MioR4D7fNbXwBAU'},
        {placeName:'Mirrabooka WA 6061, Australia',placeId:'ChIJmd6t886xMioRkEvfNbXwBAU'},
        {placeName:'North Perth WA 6006, Australia',placeId:'ChIJLaYVnLK6MioRYE3fNbXwBAU'},
        {placeName:'Northbridge WA 6003, Australia',placeId:'ChIJF_HIftK6MioRgE3fNbXwBAU'},
        {placeName:'Mount Lawley WA 6050, Australia',placeId:'ChIJL_rVreq6MioR8EvfNbXwBAU'},
        {placeName:'Osborne Park WA 6017, Australia',placeId:'ChIJreJzBGOuMioREE7fNbXwBAU'},
        {placeName:'Perth Airport WA 6105, Australia',placeId:'ChIJ5QzDHbS-MioR8E7fNbXwBAU'},
        {placeName:'South Guildford WA 6055, Australia',placeId:'ChIJu_ZO_L65MioRMFHfNbXwBAU'}
      ]}},
      profile: { description: "Gold PC Services is Perth's trusted computer and Mac repair specialist based in Bayswater, serving Morley, Bassendean, Embleton, Bedford, Inglewood, Maylands, Dianella, Noranda, and the wider Perth metro area. Since 2006, we've provided same-day computer repairs, MacBook and iMac repairs, laptop screen replacements, SSD upgrades, data recovery, and virus removal for home and business customers. We also sell quality refurbished laptops, MacBooks, and desktops with a 90-day warranty. Over 25 years IT experience. Visit us at 8A King William Street, Bayswater, or call (08) 9271 9924 for a free quote. Trade in your old device and upgrade today." },
      serviceItems: [
        {structuredServiceItem:{serviceTypeId:'job_type_id:it_consulting'}},{structuredServiceItem:{serviceTypeId:'job_type_id:tablet_repair'}},
        {freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Apple Mac Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Data Backup And Recovery'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Imac Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Imac Ssd Upgrade'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Macbook Logic Board Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Memory Upgrades'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Virus Removals'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Computer Repair Service'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Data Recovery Services'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Battery Replacement'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Broken Screen Repair'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Business It Support'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Hardware Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Mac And Computer Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Macbook Repair Services'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'On-Site Support'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Remote Support'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Software Troubleshooting'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Ssd Replacement'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Perth Computer Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Malware Cleanup'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Speed Up Your Computer'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Gaming Computers Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Refurbished Computers'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Notebook Repairs'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Ssd Drives'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'System Upgrades'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Cracked Screen'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Computer Hardware'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Computer Software'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Overheating Computer'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Network Connectivity'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Cloud Computing'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'It Security'}}},{freeFormServiceItem:{category:'categories/gcid:computer_repair_service',label:{displayName:'Pc Repairs'}}}
      ],
      metadata: { placeId: 'ChIJD0nVmWi6MioRI4X20D1cC7c' }
    },
    reviews_stats: {total_reviews:888,average_rating:4.89,reply_rate:63.2,replied_count:561,unreplied_count:327}
  });

  console.log('\n=== Syncing Project 3: Car Key Rescue ===');
  await post(3, {
    location_id: 'locations/17933670947974765351',
    profile: {
      name: 'locations/17933670947974765351', title: 'Car Key Rescue Perth',
      phoneNumbers: { primaryPhone: '0433 933 223' },
      categories: {
        primaryCategory: { name: 'categories/gcid:locksmith', displayName: 'Locksmith' },
        additionalCategories: [
          { name: 'categories/gcid:auto_parts_store', displayName: 'Auto parts store' },
          { name: 'categories/gcid:key_duplication_service', displayName: 'Key Duplication Service' },
          { name: 'categories/gcid:emergency_locksmith_service', displayName: 'Emergency locksmith service' }
        ]
      },
      websiteUri: 'https://carkeyrescueperth.com.au/',
      regularHours: { periods: [
        {openDay:'MONDAY',openTime:{hours:7},closeDay:'MONDAY',closeTime:{hours:18}},
        {openDay:'TUESDAY',openTime:{hours:7},closeDay:'TUESDAY',closeTime:{hours:18}},
        {openDay:'WEDNESDAY',openTime:{hours:7},closeDay:'WEDNESDAY',closeTime:{hours:18}},
        {openDay:'THURSDAY',openTime:{hours:7},closeDay:'THURSDAY',closeTime:{hours:18}},
        {openDay:'FRIDAY',openTime:{hours:7},closeDay:'FRIDAY',closeTime:{hours:18}}
      ]},
      serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY', places: { placeInfos: [
        {placeName:'Perth WA, Australia',placeId:'ChIJPXNH22yWMioR0FXfNbXwBAM'},
        {placeName:'Bunbury WA, Australia',placeId:'ChIJUQxXIS3iMSoRUOh5JDj2AAQ'},
        {placeName:'Mandurah WA, Australia',placeId:'ChIJLxMsBch-MioRE9hHZ7MDf8o'},
        {placeName:'Como WA 6152, Australia',placeId:'ChIJEUWXK1C8MioR8EHfNbXwBAU'},
        {placeName:'Ellenbrook WA, Australia',placeId:'ChIJXauOVFy0MioR4EPfNbXwBAU'},
        {placeName:'Atwell WA 6164, Australia',placeId:'ChIJ3YftV2iXMioRUD7fNbXwBAU'},
        {placeName:'Bicton WA 6157, Australia',placeId:'ChIJb7ESQHWkMioR8D_fNbXwBAU'},
        {placeName:'Coogee WA 6166, Australia',placeId:'ChIJ18-YA7qYMioRIELfNbXwBAU'},
        {placeName:'Success WA 6164, Australia',placeId:'ChIJNdxjMNmZMioRIFLfNbXwBAU'},
        {placeName:'Baldivis WA 6171, Australia',placeId:'ChIJd6zn-ZyPMioRgD7fNbXwBAU'},
        {placeName:'Fremantle WA 6160, Australia',placeId:'ChIJuzcI4UmiMioRgETfNbXwBAU'},
        {placeName:'Spearwood WA 6163, Australia',placeId:'ChIJP0m7AcaZMioRgFHfNbXwBAU'},
        {placeName:'Bibra Lake WA 6163, Australia',placeId:'ChIJRVSCsnyXMioR0D_fNbXwBAU'},
        {placeName:'Jarrahdale WA 6124, Australia',placeId:'ChIJb6PfoIP1MioRYEffNbXwBAU'},
        {placeName:'Rockingham WA 6168, Australia',placeId:'ChIJVRGb25ycMioR8E_fNbXwBAU'},
        {placeName:'Roleystone WA 6111, Australia',placeId:'ChIJzb66b8CUMioRAFDfNbXwBAU'},
        {placeName:'Beaconsfield WA 6162, Australia',placeId:'ChIJJTi29y-iMioRED_fNbXwBAU'},
        {placeName:'Hammond Park WA 6164, Australia',placeId:'ChIJHQTzlJGZMioRoEDhNbXwBAU'},
        {placeName:'White Gum Valley WA 6162, Australia',placeId:'ChIJPSewsDKiMioRgFTfNbXwBAU'}
      ]}},
      profile: { description: "Car Key Rescue is a mobile automotive locksmith in Perth offering fast, affordable car key replacement, repair, and programming services since 2019. We service all Perth suburbs including Fremantle, Rockingham, Butler, Canning Vale, and Armadale, coming directly to your location for convenience. With no call-out fee and prices starting from $95, we provide 7-day mobile service for smart key programming, key cutting, repairs, and emergency vehicle entry." },
      serviceItems: [
        {structuredServiceItem:{serviceTypeId:'job_type_id:car_key_program'}},{structuredServiceItem:{serviceTypeId:'job_type_id:copy_vehicle_key'}},{structuredServiceItem:{serviceTypeId:'job_type_id:vehicle_lockout'}},{structuredServiceItem:{serviceTypeId:'job_type_id:rekey_lock'}},{structuredServiceItem:{serviceTypeId:'job_type_id:new_key_fob'}},{structuredServiceItem:{serviceTypeId:'job_type_id:repair_hardware'}},
        {freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Auto Locksmith Perth'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Benz Key'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Bmw Keys'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Car Keys - cut, coded and programmed'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Car Towed'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Gain Entry'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Home Services'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Key Cutting & Programming'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Key Replacement & Programming'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Keyless Entry'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Lock Picking'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Locked Out Of Car'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Mercedes Keys'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'On-Site Key Cutting'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Proximity Keys'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Smart Keys'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Spare Car Key Cutting'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Spare Key Replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Vehicle Entry'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Auto Locksmith'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Automotive Locksmith Specialists'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Repairing Damaged / Broken Car Keys'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Keys Locked'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Mobile Automotive Locksmith'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Remote Replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Spare Key Cutting'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Toyota car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Mitsubishi car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Kia car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Ford car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Hyundai car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Mazda car key replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'Car Key Replacement'}}},{freeFormServiceItem:{category:'categories/gcid:locksmith',label:{displayName:'New Car Keys in Perth'}}}
      ],
      metadata: { placeId: 'ChIJMRtqydWZMioRg2bS576g-l4' }
    },
    reviews_stats: {total_reviews:317,average_rating:4.96,reply_rate:100,replied_count:317,unreplied_count:0}
  });

  console.log('\n=== All 3 projects synced! ===');
}

main().catch(console.error);
