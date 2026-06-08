import json

# ---------- Project 2: Gold PC Services ----------
p2_freeform = ["Apple Mac Repairs","Asus Repairs","Backing Up","Blue Screen","Broken Keyboard","Business Computer","Cleaning Your Computer","Cloud Computing","Computer Components","Computer Failure","Computer Hardware","Computer Issues","Computer Software","Computer Technicians","Computer Troubles","Cracked Screen","Customers Reviews","Data Backup And Recovery","Dell Xps","Free Diagnostics","Full Warranty","Gaming Computers Repairs","Gaming Pc","Gaming Pcs","Graphics Card","Hard Disk Failure","Hard Drive Failure","Hardware & Software Repair","Hardware Fixing","Hardware Support","Hdd Upgrade","Imac Repairs","Imac Ssd Upgrade","Information Technology","It Security","Keyboard Repairs","Keyboard Replacement","Lcd Screen","Mac Computers","Mac Ssd Upgrades","Macbook Logic Board Repairs","Macbook Upgrading","Memory Upgrades","Missing Keys","Motherboard Fix","Network Connectivity","New Device","New Homepage","Notebook Battery","Notebook Repairs","Oem Parts","On-Site","Onsite Computer Support","Operating Systems","Overheating Computer","Overheating Issues","Pc Mac","Pc Repairs North Lake","Pc Solutions","Pc Support","Performance Improvement","Quick Fix","Quick Repairing","Refurbished Computers","Refurbished Macbook","Refurbished Macs","Regular Computer Maintenance","Repair Centers","Repair Shops","Repairs And Upgrades","Restoring Data","Second Hand Computers","Slow Computer","Slow Imac","Slow Macbook","Small Business It Support","Software Fix","Solid State Drives","Ssd Drives","System Upgrades","Technical Solutions","Technology Support","Video Cards","Virus Removals","Computer Repair Service","Clean Up","Computer Repairs North Lake","Refurbished Devices","24 Hrs Services","Apple Device","Audio Systems","Battery Replacement","Broken Screen Repair","Broken Screen Replacements","Business Computer Repairs","Business It Support","Computer Issue","Computer Repair Shops","Computer Speed Up","Computer Technician","Damaged Screen Replacement","Data Recovery Services","Electronics Repairs","Gaming Computer Repairs","Hardware Issues","Hardware Repairs","Home I T","Imac Screen Replacement","Mac And Computer Repairs","Macbook Air","Macbook Repair Services","Mobile Phone","Notebook Repair","On-Site Support","Overheating Issue","Pc Repairs","Recover Deleted Files","Remote Support","Second Hand Computer","Software Issues","Software Troubleshooting","Ssd Replacement","Ssd Upgrades","Ux Design","Website Design And Development","Computer Broken","Damaged Screens","Deleted Files","Fix Your Mac","Fixing And Upgrading","Gaming Computer","Hard Drive","Hardware And Software","Imac Repairs And Upgrades","It Business Support","It Consultant","It Support Specialist","Logic Board","Mac Repairs & Upgrades","Macbook Repairs","Malware Cleanup","New Macbook","Perth Computer Repairs","Software Repairs","Solid State Drive","Speed Up Your Computer","Technical Services","Technician Services"]

def hours(open_h, close_h):
    days = ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]
    return {"periods": [{"openDay": d, "openTime": {"hours": open_h}, "closeDay": d, "closeTime": {"hours": close_h}} for d in days]}

p2_profile = {
    "name": "locations/8702513397324148400",
    "languageCode": "en",
    "storeCode": "loc-Y7tSIg6iLjPZimjsyzCg-20240717",
    "title": "Gold PC Services",
    "phoneNumbers": {"primaryPhone": "(08) 9271 9924"},
    "categories": {
        "primaryCategory": {"name": "categories/gcid:computer_repair_service", "displayName": "Computer repair service",
            "serviceTypes": [
                {"serviceTypeId": "job_type_id:installation", "displayName": "Installation"},
                {"serviceTypeId": "job_type_id:it_consulting", "displayName": "It consulting"},
                {"serviceTypeId": "job_type_id:tablet_repair", "displayName": "Tablet repair"}]},
        "additionalCategories": [
            {"name": "categories/gcid:computer_store", "displayName": "Computer Shop"},
            {"name": "categories/gcid:computer_service", "displayName": "Computer service",
             "serviceTypes": [{"serviceTypeId": "job_type_id:it_consulting", "displayName": "It consulting"}]},
            {"name": "categories/gcid:data_recovery_service", "displayName": "Data recovery service"},
            {"name": "categories/gcid:computer_hardware_manufacturer", "displayName": "Computer Hardware Company"}]},
    "storefrontAddress": {"regionCode": "AU", "languageCode": "en", "postalCode": "6053", "administrativeArea": "WA", "locality": "Bayswater", "addressLines": ["U A 8 King William Street"]},
    "websiteUri": "https://goldpc.net.au/",
    "regularHours": hours(10, 16),
    "specialHours": {"specialHourPeriods": [{"startDate": {"year": 2026, "month": 5, "day": 29}, "endDate": {"year": 2026, "month": 5, "day": 29}, "closed": True}]},
    "serviceArea": {"businessType": "CUSTOMER_AND_BUSINESS_LOCATION", "regionCode": "AU", "places": {"placeInfos": [
        {"placeName": "Perth, WA, Australia", "placeId": "ChIJC4Rr0Cq7MioRAFPLcwKhtHI"},
        {"placeName": "Ascot WA 6104, Australia", "placeId": "ChIJpdh70zO6MioRID7fNbXwBAU"},
        {"placeName": "Morley WA 6062, Australia", "placeId": "ChIJU_dpGJCwMioRoEvfNbXwBAU"},
        {"placeName": "Belmont WA 6104, Australia", "placeId": "ChIJw23v7I-7MioRsD_fNbXwBAU"},
        {"placeName": "Noranda WA 6062, Australia", "placeId": "ChIJHaAO81ewMioRIE3fNbXwBAU"},
        {"placeName": "Subiaco WA 6008, Australia", "placeId": "ChIJcfF77xalMioREFLfNbXwBAU"},
        {"placeName": "Dianella WA 6059, Australia", "placeId": "ChIJy9ZCIj6wMioRIEPfNbXwBAU"},
        {"placeName": "Maylands WA 6051, Australia", "placeId": "ChIJSUVf81e6MioR0ErfNbXwBAU"},
        {"placeName": "Bayswater WA 6053, Australia", "placeId": "ChIJkSZrj266MioRAD_fNbXwBAU"},
        {"placeName": "Beechboro WA 6063, Australia", "placeId": "ChIJ0dJunFG3MioRUD_fNbXwBAU"},
        {"placeName": "Guildford WA 6055, Australia", "placeId": "ChIJ2aJf4ty5MioRgEXfNbXwBAU"},
        {"placeName": "Inglewood WA 6052, Australia", "placeId": "ChIJQR_MlZm6MioREEffNbXwBAU"},
        {"placeName": "Bassendean WA 6054, Australia", "placeId": "ChIJLSl-sB26MioR4D7fNbXwBAU"},
        {"placeName": "Mirrabooka WA 6061, Australia", "placeId": "ChIJmd6t986xMioRkEvfNbXwBAU"},
        {"placeName": "North Perth WA 6006, Australia", "placeId": "ChIJLaYVnLK6MioRYE3fNbXwBAU"},
        {"placeName": "Northbridge WA 6003, Australia", "placeId": "ChIJF_HIftK6MioRgE3fNbXwBAU"},
        {"placeName": "Mount Lawley WA 6050, Australia", "placeId": "ChIJL_rVreq6MioR8EvfNbXwBAU"},
        {"placeName": "Osborne Park WA 6017, Australia", "placeId": "ChIJreJzBGOuMioREE7fNbXwBAU"},
        {"placeName": "Perth Airport WA 6105, Australia", "placeId": "ChIJ5QzDHbS-MioR8E7fNbXwBAU"},
        {"placeName": "South Guildford WA 6055, Australia", "placeId": "ChIJu_ZO_L65MioRMFHfNbXwBAU"}]}},
    "labels": ["Mac And Computer Repairs"],
    "openInfo": {"status": "OPEN", "canReopen": True, "openingDate": {"year": 2006, "month": 9}},
    "metadata": {"canDelete": True, "canModifyServiceList": True, "placeId": "ChIJD0nVmWi6MioRI4X20D1cC7c", "mapsUri": "https://maps.google.com/maps?cid=13189737354253206819", "newReviewUri": "https://search.google.com/local/writereview?placeid=ChIJD0nVmWi6MioRI4X20D1cC7c", "hasVoiceOfMerchant": True},
    "profile": {"description": "Gold PC Services is Perth's trusted computer and Mac repair specialist based in Bayswater, serving Morley, Bassendean, Embleton, Bedford, Inglewood, Maylands, Dianella, Noranda, and the wider Perth metro area. Since 2006, we've provided same-day computer repairs, MacBook and iMac repairs, laptop screen replacements, SSD upgrades, data recovery, and virus removal for home and business customers. We also sell quality refurbished laptops, MacBooks, and desktops with a 90-day warranty. Over 25 years IT experience. Visit us at 8A King William Street, Bayswater, or call (08) 9271 9924 for a free quote. Trade in your old device and upgrade today."},
    "serviceItems": (
        [{"structuredServiceItem": {"serviceTypeId": s}} for s in ["job_type_id:it_consulting", "job_type_id:tablet_repair"]] +
        [{"freeFormServiceItem": {"category": "categories/gcid:computer_repair_service", "label": {"displayName": n}}} for n in p2_freeform])
}

p2 = {
    "location_id": "locations/8702513397324148400",
    "profile": p2_profile,
    "reviews_stats": {"total_reviews": 890, "average_rating": 4.89, "reply_rate": 63.3, "replied_count": 563, "unreplied_count": 327, "rating_distribution": {"5": 843, "4": 27, "3": 3, "2": 0, "1": 17}},
    "posts": {"count": 0, "published_posts": []}
}

# ---------- Project 3: Car Key Rescue Perth ----------
p3_locksmith_types = [
    ("job_type_id:building_lockout","Building lockouts"),("job_type_id:car_key_program","Car digital & remote key reprogramming"),
    ("job_type_id:coded_key_copies","Coded key copying"),("job_type_id:copy_building_key","Building key copying"),
    ("job_type_id:copy_vehicle_key","Car key copying"),("job_type_id:delivery","Delivery"),
    ("job_type_id:door_lock_and_bolt_hardware_repair","Door lock & bolt hardware repair"),("job_type_id:general_repairs","General repairs"),
    ("job_type_id:install_hardware","Door lock & bolt hardware installation"),("job_type_id:installation","Installation"),
    ("job_type_id:installation_of_electronic_locks","Electronic lock installation"),("job_type_id:knife_sharpening","Knife sharpening"),
    ("job_type_id:lock_installation","General lock installation"),("job_type_id:magnetic_key_copies","Magnetic key copying"),
    ("job_type_id:multipoint_key_copies","Multipoint key copying"),("job_type_id:new_key_fob","New key fob creation"),
    ("job_type_id:pantographic_key_copying","Pantographic key copying"),("job_type_id:rekey_lock","Lock rekeying"),
    ("job_type_id:repair_hardware","Repair hardware"),("job_type_id:safe_locks","Safe lock install, open & repair"),
    ("job_type_id:security_door_locks","Security door locks"),("job_type_id:tubular_key_copying","Tubular key copying"),
    ("job_type_id:vehicle_lockout","Car lockouts"),("job_type_id:window_locks","Window locks"),
    ("job_type_id:yale_key_copying","Standard key copying")]
p3_sub_types = [
    ("job_type_id:building_lockout","Building lockouts"),("job_type_id:car_key_program","Car digital & remote key reprogramming"),
    ("job_type_id:copy_building_key","Building key copying"),("job_type_id:copy_vehicle_key","Car key copying"),
    ("job_type_id:install_hardware","Door lock & bolt hardware installation"),("job_type_id:new_key_fob","New key fob creation"),
    ("job_type_id:rekey_lock","Lock rekeying"),("job_type_id:repair_hardware","Repair hardware"),
    ("job_type_id:safe_locks","Safe lock install, open & repair"),("job_type_id:security_door_locks","Security door locks"),
    ("job_type_id:vehicle_lockout","Car lockouts"),("job_type_id:window_locks","Window locks")]
p3_freeform = ["Auto Locksmith Perth","Benz Key","Bmw Keys",
    ("Car Keys - cut, coded and programmed","Mobile automotive locksmiths. We come to you! 100% mobile service. Contact us for a no obligation quote. Professional WA licensed provider."),
    "Car Towed","Gain Entry","Home Services","Key Cutting & Programming","Key Replacement & Programming","Keyless Entry","Lock Picking","Locked Out Of Car","Locking Key","Mercedes Keys","On-Site Key Cutting","Proximity Keys","Smart Keys","Spare Car Key Cutting","Spare Key Replacement","Vehicle Entry","Auto Locksmith","Automotive Locksmith Specialists",
    ("Repairing Damaged / Broken Car Keys","We offer mobile key repairs. Whether it is a traditional metal key or a remote control, we can visit wherever you are and offer affordable and rapid repair or replacement services in Perth for any make and model."),
    "Keys Locked","Mobile Automotive Locksmith","Remote Replacement","Spare Key Cutting","Toyota car key replacement","Mitsubishi car key replacement","Kia car key replacement","Ford car key replacement","Hyundai car key replacement","Mazda car key replacement",
    ("Car Key Replacement","We offer mobile car key replacement services. Whether you have lost your primary set, had them stolen, or they have become damaged, we can visit wherever you are and offer new car keys in Perth for any make and model."),
    "New Car Keys in Perth"]

def ff(item):
    if isinstance(item, tuple):
        return {"freeFormServiceItem": {"category": "categories/gcid:locksmith", "label": {"displayName": item[0], "description": item[1]}}}
    return {"freeFormServiceItem": {"category": "categories/gcid:locksmith", "label": {"displayName": item}}}

p3_profile = {
    "name": "locations/17933670947974765351",
    "languageCode": "en",
    "storeCode": "7ec134fa-0070-4ab2-8e69-678806318b48",
    "title": "Car Key Rescue Perth",
    "phoneNumbers": {"primaryPhone": "0433 933 223"},
    "categories": {
        "primaryCategory": {"name": "categories/gcid:locksmith", "displayName": "Locksmith",
            "serviceTypes": [{"serviceTypeId": i, "displayName": d} for i, d in p3_locksmith_types]},
        "additionalCategories": [
            {"name": "categories/gcid:auto_parts_store", "displayName": "Auto parts store"},
            {"name": "categories/gcid:key_duplication_service", "displayName": "Key Duplication Service",
             "serviceTypes": [{"serviceTypeId": i, "displayName": d} for i, d in p3_sub_types]},
            {"name": "categories/gcid:emergency_locksmith_service", "displayName": "Emergency locksmith service",
             "serviceTypes": [{"serviceTypeId": i, "displayName": d} for i, d in p3_sub_types]}]},
    "websiteUri": "https://carkeyrescueperth.com.au/",
    "regularHours": hours(7, 18),
    "serviceArea": {"businessType": "CUSTOMER_LOCATION_ONLY", "regionCode": "AU", "places": {"placeInfos": [
        {"placeName": "Perth WA, Australia", "placeId": "ChIJPXNH22yWMioR0FXfNbXwBAM"},
        {"placeName": "Bunbury WA, Australia", "placeId": "ChIJUQxXIS3iMSoRUOh5JDj2AAQ"},
        {"placeName": "Mandurah WA, Australia", "placeId": "ChIJLxMsBch-MioRE9hHZ7MDf8o"},
        {"placeName": "Como WA 6152, Australia", "placeId": "ChIJEUWXK1C8MioR8EHfNbXwBAU"},
        {"placeName": "Ellenbrook WA, Australia", "placeId": "ChIJXauOVFy0MioR4EPfNbXwBAU"},
        {"placeName": "Atwell WA 6164, Australia", "placeId": "ChIJ3YftV2iXMioRUD7fNbXwBAU"},
        {"placeName": "Bicton WA 6157, Australia", "placeId": "ChIJb7ESQHWkMioR8D_fNbXwBAU"},
        {"placeName": "Coogee WA 6166, Australia", "placeId": "ChIJ18-YA7qYMioRIELfNbXwBAU"},
        {"placeName": "Success WA 6164, Australia", "placeId": "ChIJNdxjMNmZMioRIFLfNbXwBAU"},
        {"placeName": "Baldivis WA 6171, Australia", "placeId": "ChIJd6zn-ZyPMioRgD7fNbXwBAU"},
        {"placeName": "Fremantle WA 6160, Australia", "placeId": "ChIJuzcI4UmiMioRgETfNbXwBAU"},
        {"placeName": "Spearwood WA 6163, Australia", "placeId": "ChIJP0m7AcaZMioRgFHfNbXwBAU"},
        {"placeName": "Bibra Lake WA 6163, Australia", "placeId": "ChIJRVSCsnyXMioR0D_fNbXwBAU"},
        {"placeName": "Jarrahdale WA 6124, Australia", "placeId": "ChIJb6PfoIP1MioRYEffNbXwBAU"},
        {"placeName": "Rockingham WA 6168, Australia", "placeId": "ChIJVRGb25ycMioR8E_fNbXwBAU"},
        {"placeName": "Roleystone WA 6111, Australia", "placeId": "ChIJzb66b8CUMioRAFDfNbXwBAU"},
        {"placeName": "Beaconsfield WA 6162, Australia", "placeId": "ChIJJTi29y-iMioRED_fNbXwBAU"},
        {"placeName": "Hammond Park WA 6164, Australia", "placeId": "ChIJHQTzlJGZMioRoEDhNbXwBAU"},
        {"placeName": "White Gum Valley WA 6162, Australia", "placeId": "ChIJPSewsDKiMioRgFTfNbXwBAU"}]}},
    "openInfo": {"status": "OPEN", "canReopen": True, "openingDate": {"year": 2019, "month": 6}},
    "metadata": {"hasGoogleUpdated": True, "canDelete": True, "canModifyServiceList": True, "placeId": "ChIJMRtqydWZMioRg2bS576g-l4", "mapsUri": "https://maps.google.com/maps?cid=6843959325536446083", "newReviewUri": "https://search.google.com/local/writereview?placeid=ChIJMRtqydWZMioRg2bS576g-l4", "hasVoiceOfMerchant": True},
    "profile": {"description": "Car Key Rescue is a mobile automotive locksmith in Perth offering fast, affordable car key replacement, repair, and programming services since 2019. We service all Perth suburbs including Fremantle, Rockingham, Butler, Canning Vale, and Armadale, coming directly to your location for convenience. With no call-out fee and prices starting from $95, we provide 7-day mobile service for smart key programming, key cutting, repairs, and emergency vehicle entry."},
    "serviceItems": (
        [{"structuredServiceItem": {"serviceTypeId": s}} for s in ["job_type_id:car_key_program","job_type_id:copy_vehicle_key","job_type_id:vehicle_lockout","job_type_id:rekey_lock","job_type_id:new_key_fob","job_type_id:repair_hardware"]] +
        [ff(i) for i in p3_freeform])
}

p3 = {
    "location_id": "locations/17933670947974765351",
    "profile": p3_profile,
    "reviews_stats": {"total_reviews": 318, "average_rating": 4.96, "reply_rate": 100, "replied_count": 318, "unreplied_count": 0, "rating_distribution": {"5": 315, "4": 0, "3": 0, "2": 0, "1": 3}},
    "posts": {"count": 0, "published_posts": []}
}

import os
d = os.path.dirname(os.path.abspath(__file__))
json.dump(p2, open(os.path.join(d, "rc_sync_p2.json"), "w"), indent=2)
json.dump(p3, open(os.path.join(d, "rc_sync_p3.json"), "w"), indent=2)
print("wrote rc_sync_p2.json, rc_sync_p3.json")
