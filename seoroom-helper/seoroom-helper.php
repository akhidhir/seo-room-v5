<?php
/**
 * Plugin Name: SEO Room Helper
 * Description: Registers Yoast SEO meta fields for REST API access (read + write). Required by SEO Room Dashboard.
 * Version: 1.0.0
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
