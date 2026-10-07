#ifndef TABLE_HPP
#define TABLE_HPP

#include <vector>
#include <cstring>
#include <cstdint>
#include <iterator>
#include <string>
#include <iostream>

template<int maxKeySize, unsigned int arraySize>
class Table {

private:

    const static int entrySize = maxKeySize - std::bit_width(arraySize) + 1;

    using keySize = 
        typename std::conditional < entrySize <= 8, uint_least8_t,
        typename std::conditional < entrySize <= 16, uint_least16_t,
        typename std::conditional < entrySize <= 32, uint_least32_t,
        uint_least64_t>::type>::type >::type;

    using key_t = 
        typename std::conditional < maxKeySize <= 32, uint_least32_t,
        uint_least64_t>::type;

    keySize* keys;
    uint8_t* vals;

    int numKeys = 0;
    

public:

    Table() {
        keys = new keySize[arraySize];
        vals = new uint8_t[arraySize];
        reset();
    }

    void* getKeyAddress() {
        return keys;
    }

    void* getValAddress() {
        return vals;
    }

    void reset() {
        memset(keys, 0, arraySize * sizeof(keySize));
        memset(vals, 0, arraySize * sizeof(uint8_t));
    }

    void put(key_t key, uint8_t val) {
        int i = key % arraySize;
        keys[i] = (keySize)key;
        vals[i] = val;
        numKeys++;
    }

    uint8_t get(key_t key) {
        int i = key % arraySize;
        return keys[i] == (keySize)key ? vals[i] : 0;
    }

    int getSize() {
        return sizeof(keySize);
    }

    int getNumKeys() {
        return numKeys;
    }
};

#endif
