UPDATE restaurants
SET cuisine_key = 'hotpot',
    icon_key = 'hotpot.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'hotpot';

UPDATE restaurants
SET cuisine_key = 'southeast_asian',
    icon_key = 'southeast_asian.shop.' || substr(icon_key, -2)
WHERE cuisine_key IN ('thai', 'vietnamese');

UPDATE restaurants
SET cuisine_key = 'south_asian',
    icon_key = 'south_asian.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'indian';

UPDATE restaurants
SET cuisine_key = 'cantonese',
    icon_key = 'cantonese.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'cantonese';

UPDATE restaurants
SET cuisine_key = 'rice_noodles',
    icon_key = 'rice_noodles.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'noodles';

UPDATE restaurants
SET cuisine_key = 'fast_meal',
    icon_key = 'fast_meal.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'congee';

UPDATE restaurants
SET cuisine_key = 'dimsum_dumpling',
    icon_key = 'dimsum_dumpling.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'dimsum';

UPDATE restaurants
SET cuisine_key = 'coffee',
    icon_key = 'coffee.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'cafe';

UPDATE restaurants
SET cuisine_key = 'bakery_pastry',
    icon_key = 'bakery_pastry.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'bakery';

UPDATE restaurants
SET cuisine_key = 'pasta_pizza',
    icon_key = 'pasta_pizza.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'western';

UPDATE restaurants
SET cuisine_key = 'snacks',
    icon_key = 'snacks.shop.' || substr(icon_key, -2)
WHERE cuisine_key = 'other';
