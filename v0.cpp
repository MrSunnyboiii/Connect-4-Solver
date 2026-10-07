#include <iostream>
#include <vector>
#include <string>
#include <chrono>
#include <bit>
#include <limits>
#include <utility>
#include <unordered_map>
#include <fstream>
#include <numeric>
#include <future>
#include <algorithm>
#include "OpeningBook.hpp"
#include "Table_7x6.hpp"

class Connect4 {

public:

    static constexpr int ROWS = 6;
    static constexpr int COLS = 7;

    //CHANGE THIS LATER!!! ODD-SIZED BOARDS HAVE DIFFERENT MAX MOVES
    static constexpr int MAX_MOVES = (ROWS * COLS) / 2;
    static constexpr int MAX_SCORE = MAX_MOVES - 3;


    static constexpr char PIECES[3] = {'.', 'X', 'O'};
    
    uint64_t prevPieces = 0;
    uint64_t ownPieces = 0;
    uint64_t bottom_mask = 0;
    uint64_t board_mask = 0;
    uint64_t column_mask = 0;

    Table<(ROWS+1)*COLS, 8'388'593> table;
    Book book{16'777'259}; // 16'777'259 is prime, hard-coded, vals must be >=0
    // Table<49, 16'777'259> book;

    long long nodes = 0;

    int moveMult = 0;
    int naiveScores[COLS];

    Connect4() {
        for (int i = 0; i < COLS; i++) {
            bottom_mask |= (1ULL << (i * (ROWS + 1)));
        }
        board_mask = bottom_mask * ((1ULL << ROWS) - 1);
        column_mask = (1ULL << (ROWS + 1)) - 1;

        int p2 = COLS - 1;
        while (moveMult <= p2) {
            naiveScores[moveMult++] = naiveScores[p2--] = moveMult;
        }

        // Opening Book
        std::ifstream file("Assets/7x6.book", std::ios::binary);
        char width, height, depth, kBytes, vBytes, lSize;

        file.read(&width, 1);
        file.read(&height, 1);
        file.read(&depth, 1);
        file.read(&kBytes, 1);
        file.read(&vBytes, 1);
        file.read(&lSize, 1);

        file.read(reinterpret_cast<char *>(book.getKeyAddress()), book.getSize() * int(kBytes));
        file.read(reinterpret_cast<char *>(book.getValAddress()), book.getSize() * int(vBytes)); 

        file.close();
        
        runTests("Tests/Test_L2_R2");
        // displaySolve("71255763773133525731261364622167124446454");
        //takeTurn();
    }

private:

    void runTests(std::string filename) {
        std::vector<double> time;
        std::vector<int> nodeList;
        int wrong = 0;

        std::ifstream file(filename);
        std::string line;

        while (std::getline(file, line)) {
            ownPieces = prevPieces = nodes = 0;

            std::string pos = line.substr(0, line.find(' '));
            initPos(pos);

            int score = std::stoi(line.substr(line.find(' ') + 1));

            auto start = std::chrono::high_resolution_clock::now();

            // Run negaMax asynchronously with a timeout
            std::future<int> futureScore = std::async(std::launch::async, [&]() {
                return solve(ownPieces, prevPieces);
            });

            constexpr auto TIMEOUT = std::chrono::seconds(5); // Set timeout duration
            if (futureScore.wait_for(TIMEOUT) == std::future_status::ready) {
                int getScore = futureScore.get(); // Get the result if completed in time

                auto end = std::chrono::high_resolution_clock::now();
                std::chrono::duration<double> elapsed = end - start;
                time.push_back(elapsed.count());

                nodeList.push_back(nodes);
                if (getScore != score) {
                    wrong += 1;
                    std::cout << pos << ' ' << score << ' ' << getScore << "\n";
                }

                // if (nodeList.size() % 20 == 0) {
                //     std::cout << nodeList.size() << " tests completed\n";
                //     std::cout << "Average times: " << std::accumulate(time.begin(), time.end(), 0.0) / time.size() << " seconds\n";
                //     std::cout << "Wrong: " << wrong << "\n";
                //     std::cout << "Average nodes: " << std::accumulate(nodeList.begin(), nodeList.end(), 0.0) / nodeList.size() << "\n\n";
                // } 

            } else {
                std::cout << "Timeout: " << pos << ' ' << score << "\n";
            }
        }

        std::cout << "Average times: " << std::accumulate(time.begin(), time.end(), 0.0) / time.size() << " seconds\n";
        std::cout << "Wrong: " << wrong << "\n";
        std::cout << "Average nodes: " << std::accumulate(nodeList.begin(), nodeList.end(), 0.0) / nodeList.size() << "\n";
    }

    void initPos(const std::string& pos) {
        ownPieces = prevPieces = 0;
        for (char c : pos) {
            auto result = playCol(c - '1', ownPieces, prevPieces);
            ownPieces = result.first;
            prevPieces = result.second;
        }
    }

    void displaySolve(const std::string& pos) {
        initPos(pos);

        printBoard(ownPieces, prevPieces);
        std::cout << "Player " << (1 + (std::popcount(ownPieces + prevPieces) % 2)) << "'s turn\n";

        nodes = 0;

        auto start = std::chrono::high_resolution_clock::now();
        auto [move, score] = bestMove();
        auto end = std::chrono::high_resolution_clock::now();
        std::chrono::duration<double> elapsed = end - start;

        std::cout << elapsed.count() << " seconds\n";
        std::cout << nodes << " nodes explored\n";
        std::cout << "Best move: " << move << ", Score: " << score << "\n";
        std::cout << "Number of inserts: " << table.getNumKeys() << "\n";
    }

    uint64_t getBookKey(uint64_t ownPieces, uint64_t prevPieces) {
        uint64_t forward = 0, reverse = 0, p1 = 1;
        for (int i=0; i < COLS; ++i) {
            int curr = 0, p2 = 1;
            for (int j=0; j < ROWS + 1; ++j) {
                uint64_t mask = 1ULL << (j + i * (ROWS + 1));
                p2 *= 3;
                curr *= 3;
                if (mask & ownPieces)
                    curr += 1;
                else if (mask & prevPieces)
                    curr += 2;
                else
                    break;
            }
            forward = forward * p2 + curr;
            reverse += p1 * curr;
            p1 *= p2;
        }

        return std::min(forward, reverse)/3;
    }

    // For regular table, hash symmetry rarely occurs so not implemented
    uint64_t hash(uint64_t key) {
        uint64_t reverse = key;
        for (int i = 0; i < COLS/2; ++i) {
            uint64_t left_mask = column_mask << (i * (ROWS + 1));
            uint64_t right_mask = column_mask << ((COLS - 1 - i) * (ROWS + 1));

            uint64_t newLeft = (key & right_mask) >> ((COLS - 1 - 2 * i) * (ROWS + 1));
            uint64_t newRight = (key & left_mask) << ((COLS - 1 - 2 * i) * (ROWS + 1));

            reverse &= ~left_mask;
            reverse &= ~right_mask;
            reverse |= newLeft;
            reverse |= newRight;
        }
        return std::min(key, reverse);
    }

    std::pair<uint64_t, uint64_t> playCol(int col, uint64_t ownPieces, uint64_t prevPieces) {
        ownPieces |= (ownPieces + prevPieces + bottom_mask) & (column_mask << (col * (ROWS + 1)));
        return {prevPieces, ownPieces};
    }

    bool validCol(uint64_t allPieces, int col) {
        return !((allPieces + bottom_mask) & (1ULL << (ROWS + col * (ROWS + 1))));
    }

    bool checkWin(uint64_t prevPieces) {

        uint64_t vert = prevPieces & (prevPieces >> 1);
        if (vert & (vert >> 2))
            return true;

        for (int i=ROWS; i <= ROWS+2; ++i) {
            uint64_t p = prevPieces & (prevPieces >> i);
            if (p & (p >> (2 * i)))
                return true;
        }

        return false;
    }

    // Only for <= 8x7 board
    uint64_t findWinMoves(uint64_t allPieces, uint64_t ownPieces) {
        uint64_t res = (ownPieces << 1) & (ownPieces << 2) & (ownPieces << 3);

        for (int i = ROWS; i <= ROWS + 2; ++i) {
            uint64_t p = (ownPieces << i) & (ownPieces << 2 * i);
            res |= p & (ownPieces << 3 * i);
            res |= p & (ownPieces >> i);
            p = (ownPieces >> i) & (ownPieces >> 2 * i);
            res |= p & (ownPieces >> 3 * i);
            res |= p & (ownPieces << i);
        }

        return res & (board_mask ^ allPieces);
    }

    int findGoodMoves(uint64_t ownPieces, uint64_t prevPieces, std::pair<int, int> moveOrder[]) {
        uint64_t allPieces = ownPieces + prevPieces;
        uint64_t oppWinMoves = findWinMoves(allPieces, prevPieces);
        uint64_t bottomWins = oppWinMoves & (allPieces + bottom_mask);

        if (std::popcount(bottomWins) > 1) {
            return 0;
        } else if (std::popcount(bottomWins) == 1) {
            if ((bottomWins << 1) & oppWinMoves)
                return 0;
            moveOrder[0] = {1, std::countr_zero(bottomWins) / (ROWS + 1)};
            return 1;
        }

        int moveCount = 0;
        uint64_t losing = oppWinMoves >> 1;
        for (int i = 0; i < COLS; ++i) {
            if (validCol(allPieces, i) && !(losing & (allPieces + (1ULL << (i * (ROWS + 1)))))) {
                auto [newAll, newPrev] = playCol(i, ownPieces, prevPieces);
                int score = moveMult * std::popcount(findWinMoves(newAll, newPrev)) + naiveScores[i];

                int idx = moveCount;
                while (idx > 0 && moveOrder[idx - 1].first < score) {
                    moveOrder[idx] = moveOrder[idx - 1];
                    --idx;
                }

                moveOrder[idx] = {score, i};
                ++moveCount;
            }
        }

        return moveCount;
    }

    int negaMax(uint64_t ownPieces, uint64_t prevPieces, int alpha = -MAX_SCORE, int beta  = MAX_SCORE) {
        nodes++;

        int ownMoves = std::popcount(ownPieces);
        int oppMoves = std::popcount(prevPieces);

        // Position in opening book
        // uint64_t book_key = getBookKey(ownPieces, prevPieces);
        // if (totMoves < 14 && book.inTable(book_key))
        //     return (int)book.get(book_key) - 19;
        
        // If no more moves, opponent wins next move
        std::pair<int, int> moveOrder[COLS];
        int moveCount = findGoodMoves(ownPieces, prevPieces, moveOrder);
        if (moveCount == 0)
            return oppMoves - MAX_MOVES;

        // Draw
        if (oppMoves >= MAX_MOVES)
            return 0;

        int newBeta = std::min(beta, MAX_MOVES - ownMoves - 1);
        if (newBeta <= alpha)
            return newBeta;

        int newAlpha = std::max(alpha, oppMoves - MAX_MOVES + 1);
        if (newBeta <= newAlpha)         
            return newAlpha;

        uint64_t key = ownPieces + (prevPieces << 1) + bottom_mask;
        
        
        int val = table.get(key);
        if (val > 0) {
            //UPPER
            if (val & (1 << 6)) {
                newBeta = std::min(newBeta, val - MAX_SCORE - 1 - (1 << 6));
                if (newBeta <= newAlpha)
                    return newBeta;
            //LOWER
            } else {
                newAlpha = std::max(newAlpha, val - MAX_SCORE - 1);
                if (newBeta <= newAlpha)
                    return newAlpha;
            }
        }

        for (int i=0; i<moveCount; ++i) {
            auto [newAll, newPrev] = playCol(moveOrder[i].second, ownPieces, prevPieces);
            int score = -negaMax(newAll, newPrev, -newBeta, -newAlpha);
            if (score > newAlpha) {
                newAlpha = score;
                if (newBeta <= newAlpha) {
                    break;
                }
            }
        }

        if (newAlpha <= alpha)
            table.put(key, newAlpha + MAX_SCORE + 1 + (1 << 6)); // UPPER
        else
            table.put(key, newAlpha + MAX_SCORE + 1); // LOWER

        return newAlpha;
    }

    int solve(uint64_t ownPieces, uint64_t prevPieces) {
        int ownMoves = std::popcount(ownPieces);
        int oppMoves = std::popcount(prevPieces);

        if (findWinMoves(ownPieces + prevPieces, ownPieces) & (ownPieces + prevPieces + bottom_mask))
            return MAX_MOVES - ownMoves;

        int minScore = oppMoves - MAX_MOVES;
        int maxScore = MAX_MOVES - ownMoves - 1;

        while (minScore<maxScore) {
            int med = minScore + (maxScore - minScore) / 2;
            med = med > 0 ? std::max(med, maxScore / 2) : std::min(med, minScore / 2);
            
            int score = negaMax(ownPieces, prevPieces, med, med + 1);
            if (score <= med)
                maxScore = score;
            else
                minScore = score;
        }
        return minScore;
    }

    std::pair<int, int> bestMove() {

        int maxVal = std::numeric_limits<int>::min();
        int bestCol = -1;
        std::vector<int> columns(COLS, -100);

        for (int i = 0; i < COLS; ++i) {
            if (!validCol(ownPieces + prevPieces, i))
                continue;

            auto [newOwn, newPrev] = playCol(i, ownPieces, prevPieces);

            int score;
            if (checkWin(newPrev))
                score = MAX_MOVES - std::popcount(newPrev) + 1;
            else
                score = -solve(newOwn, newPrev);

            columns[i] = score;

            if (score > maxVal) {
                maxVal = score;
                bestCol = i;
            }
        }

        std::cout << "\n";
        for (const auto& score : columns) {
            if (score == -100)
                std::cout << "None ";
            else
                std::cout << score << " ";
        }
        std::cout << "\n\n";

        return {bestCol + 1, maxVal};
    }

    void printBoard(uint64_t ownPieces, uint64_t prevPieces) {
        int turn = 2 - std::popcount(ownPieces + prevPieces)%2;
        
        std::cout << "\n\n";
        for (int c = 1; c <= COLS; c++)
            std::cout << c << "\t";
        std::cout << "\n";

        for (int row = ROWS - 1; row >= 0; row--) {
            for (int col = 0; col < COLS; col++) {

                uint64_t mask = 1ULL << (row + col * (ROWS + 1));

                if (mask & prevPieces)
                    std::cout << PIECES[turn];
                else if (mask & ownPieces)
                    std::cout << PIECES[3 - turn];
                else
                    std::cout << PIECES[0];
                std::cout << "\t";
            }
            std::cout << "\n";
        }
        std::cout << "\n";
    }

    void takeTurn() {
        printBoard(ownPieces, prevPieces);

        int colPick;
        std::cout << "Player " << (1 + (std::popcount(ownPieces + prevPieces) % 2)) << ", pick a column: ";
        std::cin >> colPick;
        colPick--;

        if (colPick < 0 || colPick >= COLS || !validCol(ownPieces + prevPieces, colPick)) {
            std::cout << "Invalid move.\n";
            takeTurn();
            return;
        }

        auto [newOwn, newPrev] = playCol(colPick, ownPieces, prevPieces);

        ownPieces = newOwn;
        prevPieces = newPrev;

        if (checkWin(prevPieces)) {
            winGame(2 - (std::popcount(ownPieces + prevPieces) % 2));
        }
        else if (ownPieces + prevPieces == board_mask) {
            drawGame();
        }
        else {
            takeTurn();
        }
    }

    void winGame(int turn) {
        printBoard(ownPieces, prevPieces);
        std::cout << "Congratulations, Player " << turn << ". You win!\n";
    }

    void drawGame() {
        printBoard(ownPieces, prevPieces);
        std::cout << "Draw.\n";
    }
};

int main() {
    Connect4 game;
    return 0;
}
