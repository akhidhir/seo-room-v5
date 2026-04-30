<?php
/**
 * Plugin Name: SEO Room Helper
 * Description: Registers Yoast SEO meta fields for REST API access (read + write). Required by SEO Room Dashboard.
 * Version: 1.2.0
 * Author: The SEO Room
 */

if (!defined('ABSPATH')) exit;

add_action('init', function() {
    $post_types = ['page', 'post'];
    $meta_keys = [
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_focuskw',
        '_yoast_wpseo_linkdex',
        '_yoast_wpseo_content_score',
        '_elementor_data',
        '_elementor_css',
    ];

    foreach ($post_types as $type) {
        foreach ($meta_keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => function() { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

// Also register without underscore prefix (some Yoast versions use both)
add_action('init', function() {
    $post_types = ['page', 'post'];
    $meta_keys = [
        'yoast_wpseo_title',
        'yoast_wpseo_metadesc',
        'yoast_wpseo_focuskw',
    ];

    foreach ($post_types as $type) {
        foreach ($meta_keys as $key) {
            register_post_meta($type, $key, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => function() { return current_user_can('edit_posts'); },
            ]);
        }
    }
});

// Expose yoast_head_json in REST API responses (already done by Yoast, but ensure it)
add_filter('rest_prepare_page', 'seoroom_add_yoast_to_rest', 10, 3);
add_filter('rest_prepare_post', 'seoroom_add_yoast_to_rest', 10, 3);

function seoroom_add_yoast_to_rest($response, $post, $request) {
    // Add raw Yoast meta for easy access
    $response->data['seoroom_yoast'] = [
        'title'         => get_post_meta($post->ID, '_yoast_wpseo_title', true),
        'description'   => get_post_meta($post->ID, '_yoast_wpseo_metadesc', true),
        'focus_keyword' => get_post_meta($post->ID, '_yoast_wpseo_focuskw', true),
        'seo_score'     => get_post_meta($post->ID, '_yoast_wpseo_linkdex', true),
        'content_score' => get_post_meta($post->ID, '_yoast_wpseo_content_score', true),
    ];
    return $response;
}

// REST endpoint: /wp-json/seoroom/v1/yoast-scores
add_action('rest_api_init', function() {
    register_rest_route('seoroom/v1', '/yoast-scores', [
        'methods'  => 'GET',
        'callback' => 'seoroom_yoast_scores',
        'permission_callback' => function() { return current_user_can('edit_posts'); },
    ]);
});

function seoroom_yoast_scores() {
    $results = [];
    $post_types = ['page', 'post'];
    foreach ($post_types as $type) {
        $posts = get_posts([
            'post_type'      => $type,
            'post_status'    => 'publish',
            'posts_per_page' => -1,
        ]);
        foreach ($posts as $p) {
            $results[] = [
                'id'            => $p->ID,
                'title'         => $p->post_title,
                'type'          => $type,
                'focus_keyword' => get_post_meta($p->ID, '_yoast_wpseo_focuskw', true),
                'seo_score'     => get_post_meta($p->ID, '_yoast_wpseo_linkdex', true),
                'content_score' => get_post_meta($p->ID, '_yoast_wpseo_content_score', true),
                'meta_title'    => get_post_meta($p->ID, '_yoast_wpseo_title', true),
                'meta_desc'     => get_post_meta($p->ID, '_yoast_wpseo_metadesc', true),
            ];
        }
    }
    return rest_ensure_response($results);
}
